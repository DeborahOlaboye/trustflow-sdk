/** @jest-environment jsdom */
import { act, render, renderHook } from '@testing-library/react';
import { createElement, memo } from 'react';
import {
  useMultiSigOperation,
  type MultiSigOperationSource,
} from '../src/hooks/useMultiSigOperation';
import type { MultiSigStatus, SignatureEntry } from '../src/types/multisig';

async function tick(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const signer = (n: number): SignatureEntry => ({
  signerAddress: `G${n}`,
  signedXdr: `xdr-${n}`,
  addedAt: n,
});

/**
 * A source that, like MultiSigEscrowClient, builds brand-new status and
 * signature arrays on every call even when nothing changed.
 */
function fakeSource(initial: SignatureEntry[], status: MultiSigStatus['status'] = 'pending') {
  const state = { signatures: initial, status };
  const source: MultiSigOperationSource = {
    getMultiSigStatus: jest.fn((operationId: string) => ({
      ok: true as const,
      data: {
        operationId,
        escrowId: 'E1',
        operationType: 'release' as const,
        signaturesCollected: state.signatures.length,
        threshold: 2,
        signersAuthorised: ['G1', 'G2', 'G3'],
        signersSigned: state.signatures.map((s) => s.signerAddress),
        signersRemaining: ['G1', 'G2', 'G3'].filter(
          (a) => !state.signatures.some((s) => s.signerAddress === a),
        ),
        isReady: state.signatures.length >= 2,
        status: state.status,
        createdAt: 0,
      },
    })),
    exportState: jest.fn((operationId: string) => ({
      operationId,
      escrowId: 'E1',
      operationType: 'release' as const,
      unsignedXdr: 'base',
      networkPassphrase: 'test',
      // Fresh objects every call, as exportState really does.
      collectedSignatures: state.signatures.map((s) => ({ ...s })),
      threshold: 2,
      signers: ['G1', 'G2', 'G3'],
      status: state.status,
      createdAt: 0,
      version: 1,
    })),
  };
  return { source, state };
}

describe('useMultiSigOperation (#784)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns the same signatures array across polls when nothing changed', async () => {
    const { source } = fakeSource([signer(1)]);
    const { result } = renderHook(() => useMultiSigOperation(source, 'op1', { interval: 1000 }));
    await tick(0);
    const first = result.current.signatures;
    expect(first).toHaveLength(1);

    await tick(1000);
    await tick(1000);
    expect(source.getMultiSigStatus).toHaveBeenCalledTimes(3);
    expect(result.current.signatures).toBe(first);
  });

  it('does not re-render a React.memo child on unchanged polls (issue repro)', async () => {
    const { source, state } = fakeSource([signer(1)]);
    let childRenders = 0;
    const Child = memo(function Child(props: { signatures: SignatureEntry[] }) {
      childRenders++;
      return createElement('span', null, props.signatures.length);
    });
    function Parent() {
      const { signatures } = useMultiSigOperation(source, 'op1', { interval: 1000 });
      return createElement(Child, { signatures });
    }
    render(createElement(Parent));
    await tick(0);
    const afterFirstLoad = childRenders;

    await tick(1000);
    await tick(1000);
    await tick(1000);
    expect(childRenders).toBe(afterFirstLoad);

    // A real new signature does reach the child.
    state.signatures = [signer(1), signer(2)];
    await tick(1000);
    expect(childRenders).toBe(afterFirstLoad + 1);
  });

  it('reuses unchanged signature entries when a new one is added', async () => {
    const { source, state } = fakeSource([signer(1)]);
    const { result } = renderHook(() => useMultiSigOperation(source, 'op1', { interval: 1000 }));
    await tick(0);
    const [firstEntry] = result.current.signatures;

    state.signatures = [signer(1), signer(2)];
    await tick(1000);
    expect(result.current.signatures).toHaveLength(2);
    expect(result.current.signatures[0]).toBe(firstEntry);
    expect(result.current.isReady).toBe(true);
  });

  it('stops polling once the operation is submitted or expired', async () => {
    const { source, state } = fakeSource([signer(1)]);
    renderHook(() => useMultiSigOperation(source, 'op1', { interval: 1000 }));
    await tick(0);
    state.status = 'submitted';
    await tick(1000);
    const calls = (source.getMultiSigStatus as jest.Mock).mock.calls.length;
    await tick(5000);
    expect(source.getMultiSigStatus).toHaveBeenCalledTimes(calls);
  });

  it('idles with a stable empty array when operationId is null', async () => {
    const { source } = fakeSource([]);
    const { result, rerender } = renderHook(() => useMultiSigOperation(source, null));
    await tick(5000);
    const empty = result.current.signatures;
    rerender();
    expect(result.current).toMatchObject({ status: null, loading: false, isReady: false });
    expect(result.current.signatures).toBe(empty);
    expect(source.getMultiSigStatus).not.toHaveBeenCalled();
  });

  it('surfaces a not-found operation as an error', async () => {
    const source: MultiSigOperationSource = {
      getMultiSigStatus: () => ({ ok: false, error: 'Operation op9 not found' }),
    };
    const { result } = renderHook(() => useMultiSigOperation(source, 'op9'));
    await tick(0);
    expect(result.current.error?.message).toBe('Operation op9 not found');
  });
});
