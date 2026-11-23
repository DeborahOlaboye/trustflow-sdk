import { useCallback, useEffect, useRef, useState } from 'react';
import type { IPFSUploadOptions, IPFSUploadResult } from '../storage/ipfs';
import type { SDKResult } from '../types';

/** Anything that can pin a file to IPFS. `IPFSStorage` satisfies it. */
export interface DeliverableUploader {
  upload(
    file: Blob | Uint8Array | ArrayBuffer,
    options?: IPFSUploadOptions,
  ): Promise<SDKResult<IPFSUploadResult>>;
}

/** A pinned deliverable, handed to `submit`. */
export interface PinnedDeliverable<F> {
  cid: string;
  url: string;
  milestoneId: string;
  file: F;
}

export interface UseDeliverableUploadOptions<R> {
  /** Pins the file, usually an `IPFSStorage`. */
  storage: DeliverableUploader;
  /**
   * Records the pinned deliverable against the milestone, e.g. a call to your
   * backend. The SDK has no deliverable-submission endpoint yet, so the
   * integrator supplies this step; whatever it returns is the hook's `result`.
   */
  submit: (deliverable: PinnedDeliverable<Blob | Uint8Array | ArrayBuffer>) => Promise<R>;
  /**
   * Give up on pinning after this long, so an unavailable pinning provider
   * ends in a clear error instead of a silent hang. Defaults to 60 seconds.
   */
  pinTimeoutMs?: number;
}

export type DeliverableUploadStatus = 'idle' | 'pinning' | 'submitting' | 'success' | 'error';

/** Which step failed, so pin and submission failures can be handled differently. */
export interface DeliverableUploadError {
  stage: 'pin' | 'submit';
  message: string;
  cause?: unknown;
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Pins a deliverable to IPFS and submits the resulting CID for a milestone,
 * as one flow with progress (#785).
 *
 * - `progress` is the pinning upload's 0–1 fraction, from the bytes the HTTP
 *   client has sent, or null when the size is unknown or no upload is running.
 * - `error.stage` says whether pinning or submission failed. After a submit
 *   failure the CID is kept, and `retrySubmit()` resubmits without uploading
 *   the file again.
 * - Starting a new upload, calling `cancel()`, or unmounting aborts the
 *   in-flight pin and ignores any late results.
 */
export function useDeliverableUpload<R = unknown>(options: UseDeliverableUploadOptions<R>) {
  const [status, setStatus] = useState<DeliverableUploadStatus>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<DeliverableUploadError | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const [pinned, setPinned] = useState<PinnedDeliverable<Blob | Uint8Array | ArrayBuffer> | null>(
    null,
  );

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      runRef.current++;
      controllerRef.current?.abort();
    },
    [],
  );

  const submitPinned = useCallback(
    async (deliverable: PinnedDeliverable<Blob | Uint8Array | ArrayBuffer>, run: number) => {
      setStatus('submitting');
      setProgress(null);
      setError(null);
      try {
        const value = await optionsRef.current.submit(deliverable);
        if (run !== runRef.current) return null;
        setResult(value);
        setStatus('success');
        return value;
      } catch (cause) {
        if (run !== runRef.current) return null;
        setError({ stage: 'submit', message: `Submission failed: ${errorMessage(cause)}`, cause });
        setStatus('error');
        return null;
      }
    },
    [],
  );

  const upload = useCallback(
    async (file: Blob | Uint8Array | ArrayBuffer, milestoneId: string): Promise<R | null> => {
      const run = ++runRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { storage, pinTimeoutMs = 60_000 } = optionsRef.current;

      setStatus('pinning');
      setProgress(0);
      setError(null);
      setResult(null);
      setPinned(null);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, pinTimeoutMs);

      let pin: SDKResult<IPFSUploadResult>;
      try {
        pin = await storage.upload(file, {
          abortSignal: controller.signal,
          filename: typeof File !== 'undefined' && file instanceof File ? file.name : undefined,
          onUploadProgress: (p) => {
            if (run === runRef.current && p.fraction !== null) setProgress(p.fraction);
          },
        });
      } catch (cause) {
        pin = {
          ok: false,
          error: timedOut
            ? `Pinning timed out after ${Math.round(pinTimeoutMs / 1000)}s; the pinning provider may be unavailable`
            : errorMessage(cause),
        };
      } finally {
        clearTimeout(timer);
      }

      if (run !== runRef.current) return null;
      if (!pin.ok) {
        setError({ stage: 'pin', message: `Could not pin the file to IPFS: ${pin.error}` });
        setStatus('error');
        setProgress(null);
        return null;
      }

      setProgress(1);
      const deliverable = { cid: pin.data.cid, url: pin.data.url, milestoneId, file };
      setPinned(deliverable);
      return submitPinned(deliverable, run);
    },
    [submitPinned],
  );

  /** Resubmits the already-pinned CID after a submission failure. */
  const retrySubmit = useCallback(async (): Promise<R | null> => {
    if (!pinned) return null;
    const run = ++runRef.current;
    return submitPinned(pinned, run);
  }, [pinned, submitPinned]);

  const cancel = useCallback(() => {
    runRef.current++;
    controllerRef.current?.abort();
    setStatus('idle');
    setProgress(null);
  }, []);

  const reset = useCallback(() => {
    cancel();
    setError(null);
    setResult(null);
    setPinned(null);
  }, [cancel]);

  return {
    upload,
    retrySubmit,
    cancel,
    reset,
    status,
    progress,
    error,
    result,
    /** CID of the pinned file, once pinning has succeeded. */
    cid: pinned?.cid ?? null,
  };
}
