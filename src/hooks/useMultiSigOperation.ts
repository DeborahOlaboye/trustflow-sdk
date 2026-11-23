import type {
  GetStatusResult,
  MultiSigStateSnapshot,
  MultiSigStatus,
  SignatureEntry,
} from '../types/multisig';
import { usePolling } from './usePolling';

/**
 * What `useMultiSigOperation` reads from. `MultiSigEscrowClient` satisfies it;
 * so can an async, backend-backed store once one exists, since both methods
 * may return a promise.
 */
export interface MultiSigOperationSource {
  getMultiSigStatus(operationId: string): GetStatusResult | Promise<GetStatusResult>;
  exportState?(
    operationId: string,
  ): MultiSigStateSnapshot | undefined | Promise<MultiSigStateSnapshot | undefined>;
}

export interface UseMultiSigOperationOptions {
  /** Poll interval in ms. Defaults to 3000. */
  interval?: number;
  /** Pause while the tab is hidden. Defaults to true. */
  pauseWhenHidden?: boolean;
}

interface MultiSigSnapshot {
  status: MultiSigStatus;
  signatures: SignatureEntry[];
}

const TERMINAL = new Set(['submitted', 'expired']);

/**
 * Polls a multi-sig operation's signature-collection state.
 *
 * Built on {@link usePolling}, so `status` and `signatures` keep the same
 * object references across polls until something actually changes — a
 * `React.memo` child that receives `signatures` re-renders only when a new
 * signature arrives (#784). When only some entries change, the unchanged
 * `SignatureEntry` objects are reused too. Polling stops once the operation
 * is `submitted` or `expired`.
 *
 * @param source - Usually a `MultiSigEscrowClient`
 * @param operationId - ID from `initMultiSigOperation`; pass null to idle
 */
export function useMultiSigOperation(
  source: MultiSigOperationSource,
  operationId: string | null,
  options: UseMultiSigOperationOptions = {},
) {
  const { interval = 3_000, pauseWhenHidden = true } = options;

  const { data, error, loading, refresh } = usePolling<MultiSigSnapshot | null>(
    async () => {
      if (!operationId) return null;
      const result = await source.getMultiSigStatus(operationId);
      if (!result.ok) throw new Error(result.error);
      const snapshot = source.exportState ? await source.exportState(operationId) : undefined;
      return { status: result.data, signatures: snapshot?.collectedSignatures ?? [] };
    },
    {
      interval,
      pauseWhenHidden,
      enabled: operationId !== null,
      key: operationId,
      stopWhen: (snapshot) => snapshot !== null && TERMINAL.has(snapshot.status.status),
    },
  );

  return {
    status: data?.status ?? null,
    signatures: data?.signatures ?? EMPTY_SIGNATURES,
    isReady: data?.status.isReady ?? false,
    loading: operationId !== null && loading,
    error,
    refresh,
  };
}

// A single empty array, so "no signatures yet" is also referentially stable.
const EMPTY_SIGNATURES: SignatureEntry[] = [];
