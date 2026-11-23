import { useCallback, useEffect, useRef, useState } from 'react';
import { replaceEqualDeep } from './structuralSharing';

export interface UsePollingOptions<T = unknown> {
  /** Delay between the end of one fetch and the start of the next, in ms. */
  interval: number;
  /** Set to false to stop polling (and skip the initial fetch). Defaults to true. */
  enabled?: boolean;
  /**
   * Pause while the browser tab is hidden and fetch once immediately when it
   * becomes visible again. Defaults to true. Has no effect outside a browser.
   */
  pauseWhenHidden?: boolean;
  /**
   * Identity of what is being polled (e.g. an operation id). When it changes,
   * data is cleared and polling restarts for the new key.
   */
  key?: string | number | null;
  /** Stop polling once this returns true for fetched data (e.g. a terminal status). */
  stopWhen?: (data: T) => boolean;
}

export interface UsePollingResult<T> {
  /** Latest data. Keeps the same reference while polls return equal data. */
  data: T | undefined;
  /** Error from the most recent fetch, cleared by the next successful one. */
  error: Error | null;
  /** True until the first fetch settles. */
  loading: boolean;
  /** Fetches now and restarts the interval from this fetch. */
  refresh: () => Promise<void>;
}

/**
 * Shared polling primitive for the hooks module (#786).
 *
 * Every behaviour the separately filed polling bugs asked for lives here
 * once, instead of being re-implemented per hook:
 * - **Stable references.** Results go through `replaceEqualDeep`, so a poll
 *   that returns equal data returns the previous object (#784).
 * - **Tab visibility.** Polling stops while `document.hidden` and resumes
 *   with an immediate fetch when the tab is shown again (#783).
 * - **No refetch loops.** `fetchFn` is read through a ref, so passing an
 *   inline function or a fresh options object every render does not restart
 *   polling; only `interval`, `enabled` and `pauseWhenHidden` do.
 * - **Keys and stop conditions.** Changing `key` clears data and restarts;
 *   `stopWhen` ends polling once the data reaches a final state.
 * - **No overlap.** The next fetch is scheduled after the previous one
 *   settles (setTimeout chaining, not setInterval), and results from a fetch
 *   that started before a restart or unmount are discarded.
 */
export function usePolling<T>(
  fetchFn: () => Promise<T> | T,
  options: UsePollingOptions<T>,
): UsePollingResult<T> {
  const { interval, enabled = true, pauseWhenHidden = true, key = null } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);

  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;
  const stopWhenRef = useRef(options.stopWhen);
  stopWhenRef.current = options.stopWhen;
  const stoppedRef = useRef(false);
  // Bumped on every restart/unmount; a fetch only commits if it still matches.
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef<() => Promise<void>>(async () => {});

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    stoppedRef.current = false;
    const isHidden = () =>
      pauseWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = () => {
      clearTimer();
      // A manual refresh() while disabled fetches once but never restarts polling.
      if (!enabled || stoppedRef.current || generation !== generationRef.current || isHidden()) {
        return;
      }
      timerRef.current = setTimeout(() => void run(), interval);
    };

    const run = async () => {
      clearTimer();
      try {
        const next = await fetchRef.current();
        if (generation !== generationRef.current) return;
        setData((prev) => (prev === undefined ? next : replaceEqualDeep(prev, next)));
        setError(null);
        if (stopWhenRef.current?.(next)) stoppedRef.current = true;
      } catch (cause) {
        if (generation !== generationRef.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          schedule();
        }
      }
    };
    runRef.current = run;

    if (!enabled) {
      setLoading(false);
      return () => {
        generationRef.current++;
      };
    }

    const onVisibilityChange = () => {
      if (isHidden()) clearTimer();
      else if (!stoppedRef.current) void run();
    };
    if (pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (!isHidden()) void run();

    return () => {
      generationRef.current++;
      clearTimer();
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [interval, enabled, pauseWhenHidden, key]);

  // A new key must not show the previous key's data while its first fetch runs.
  const [dataKey, setDataKey] = useState(key);
  if (dataKey !== key) {
    setDataKey(key);
    setData(undefined);
    setError(null);
    setLoading(enabled);
  }

  const refresh = useCallback(() => runRef.current(), []);

  return { data, error, loading, refresh };
}
