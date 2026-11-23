/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { replaceEqualDeep } from '../src/hooks/structuralSharing';
import { usePolling } from '../src/hooks/usePolling';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Lets pending promise callbacks (the fetch and its state updates) run. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

describe('replaceEqualDeep', () => {
  it('returns the previous value when deeply equal', () => {
    const prev = { a: [1, { b: 'x' }], c: null };
    expect(replaceEqualDeep(prev, { a: [1, { b: 'x' }], c: null })).toBe(prev);
  });

  it('reuses unchanged members inside a changed structure', () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = replaceEqualDeep(prev, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
    expect(next[2]).toEqual({ id: 3 });
  });

  it('treats added, removed and changed keys as changes', () => {
    const prev: Record<string, number> = { a: 1 };
    expect(replaceEqualDeep(prev, { a: 1, b: 2 })).not.toBe(prev);
    expect(replaceEqualDeep({ a: 1, b: 2 } as Record<string, number>, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep(prev, { a: 2 })).toEqual({ a: 2 });
  });

  it('compares non-plain objects by identity', () => {
    const d1 = new Date(0);
    const d2 = new Date(0);
    expect(replaceEqualDeep({ d: d1 }, { d: d2 }).d).toBe(d2);
  });
});

describe('usePolling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches immediately and then every interval', async () => {
    const fetchFn = jest.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolling(fetchFn, { interval: 1000 }));
    expect(result.current.loading).toBe(true);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ data: 1, loading: false, error: null });

    await tick(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps the same data reference while polls return equal data', async () => {
    let n = 0;
    const fetchFn = jest.fn(async () => (n < 2 ? { items: [{ id: 1 }] } : { items: [{ id: 2 }] }));
    const { result } = renderHook(() => usePolling(fetchFn, { interval: 1000 }));
    await flush();
    const first = result.current.data;

    n = 1;
    await tick(1000);
    expect(result.current.data).toBe(first);

    n = 2;
    await tick(1000);
    expect(result.current.data).not.toBe(first);
    expect(result.current.data).toEqual({ items: [{ id: 2 }] });
  });

  it('does not restart polling when given a new inline fetchFn each render', async () => {
    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ v }) => usePolling(async () => calls.push(v), { interval: 1000 }),
      {
        initialProps: { v: 1 },
      },
    );
    await flush();
    rerender({ v: 2 });
    rerender({ v: 3 });
    await flush();
    expect(calls).toEqual([1]);

    await tick(1000);
    // The next scheduled poll uses the latest function.
    expect(calls).toEqual([1, 3]);
  });

  it('pauses while the tab is hidden and fetches immediately when shown', async () => {
    const fetchFn = jest.fn().mockResolvedValue('ok');
    renderHook(() => usePolling(fetchFn, { interval: 1000 }));
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await tick(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps polling while hidden when pauseWhenHidden is false', async () => {
    const fetchFn = jest.fn().mockResolvedValue('ok');
    renderHook(() => usePolling(fetchFn, { interval: 1000, pauseWhenHidden: false }));
    await flush();
    act(() => setVisibility('hidden'));
    await tick(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow fetch with the next one', async () => {
    let resolve: (v: number) => void = () => {};
    const fetchFn = jest.fn(() => new Promise<number>((r) => (resolve = r)));
    renderHook(() => usePolling(fetchFn, { interval: 100 }));
    await tick(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await act(async () => resolve(1));
    await tick(100);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports errors and clears them on the next success', async () => {
    const fetchFn = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(5);
    const { result } = renderHook(() => usePolling(fetchFn, { interval: 1000 }));
    await flush();
    expect(result.current.error?.message).toBe('down');
    await tick(1000);
    expect(result.current).toMatchObject({ data: 5, error: null });
  });

  it('stops once stopWhen returns true', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce('pending').mockResolvedValue('done');
    renderHook(() => usePolling(fetchFn, { interval: 1000, stopWhen: (d) => d === 'done' }));
    await flush();
    await tick(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await tick(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not fetch or poll when disabled', async () => {
    const fetchFn = jest.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolling(fetchFn, { interval: 1000, enabled: false }));
    await tick(5000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('clears data and restarts when the key changes, discarding stale results', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetchFn = jest.fn(() => new Promise<string>((r) => resolvers.push(r)));
    const { result, rerender } = renderHook(
      ({ k }) => usePolling(fetchFn, { interval: 1000, key: k }),
      { initialProps: { k: 'a' } },
    );
    await flush();
    await act(async () => resolvers[0]('A'));
    expect(result.current.data).toBe('A');

    rerender({ k: 'b' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1]('B'));
    expect(result.current.data).toBe('B');
  });

  it('refresh fetches now', async () => {
    const fetchFn = jest.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolling(fetchFn, { interval: 60_000 }));
    await flush();
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stops after unmount', async () => {
    const fetchFn = jest.fn().mockResolvedValue(1);
    const { unmount } = renderHook(() => usePolling(fetchFn, { interval: 1000 }));
    await flush();
    unmount();
    await tick(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
