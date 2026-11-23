/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { useDeliverableUpload, type DeliverableUploader } from '../src/hooks/useDeliverableUpload';
import { IPFSStorage } from '../src/storage/ipfs';
import type { IPFSUploadOptions } from '../src/storage/ipfs';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const file = new Uint8Array([1, 2, 3, 4]);

/** An uploader that reports progress in steps, then resolves with a CID. */
function steppedUploader(): DeliverableUploader & { upload: jest.Mock } {
  return {
    upload: jest.fn(async (_f: unknown, options: IPFSUploadOptions = {}) => {
      options.onUploadProgress?.({ loaded: 1, total: 4, fraction: 0.25 });
      options.onUploadProgress?.({ loaded: 4, total: 4, fraction: 1 });
      return { ok: true as const, data: { cid: CID, url: `https://gw/ipfs/${CID}` } };
    }),
  };
}

describe('useDeliverableUpload (#785)', () => {
  it('pins, then submits the CID for the milestone', async () => {
    const storage = steppedUploader();
    const submit = jest.fn().mockResolvedValue({ id: 'd1' });
    const { result } = renderHook(() => useDeliverableUpload({ storage, submit }));

    let value: unknown;
    await act(async () => {
      value = await result.current.upload(file, 'm1');
    });

    expect(value).toEqual({ id: 'd1' });
    expect(submit).toHaveBeenCalledWith({
      cid: CID,
      url: `https://gw/ipfs/${CID}`,
      milestoneId: 'm1',
      file,
    });
    expect(result.current).toMatchObject({
      status: 'success',
      result: { id: 'd1' },
      cid: CID,
      error: null,
    });
  });

  it('reports pinning progress as it happens, not just pending/done', async () => {
    const seen: Array<number | null> = [];
    let release: () => void = () => {};
    const storage: DeliverableUploader = {
      upload: async (_f, options = {}) => {
        options.onUploadProgress?.({ loaded: 1, total: 4, fraction: 0.25 });
        await new Promise<void>((r) => (release = r));
        options.onUploadProgress?.({ loaded: 3, total: 4, fraction: 0.75 });
        return { ok: true, data: { cid: CID, url: 'u' } };
      },
    };
    const { result } = renderHook(() =>
      useDeliverableUpload({ storage, submit: async () => 'ok' }),
    );

    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.upload(file, 'm1');
    });
    expect(result.current.status).toBe('pinning');
    seen.push(result.current.progress);
    await act(async () => {
      release();
      await pending;
    });
    seen.push(result.current.progress);
    expect(seen).toEqual([0.25, null]);
    expect(result.current.status).toBe('success');
  });

  it('distinguishes a pin failure from a submission failure', async () => {
    const storage: DeliverableUploader = {
      upload: async () => ({ ok: false, error: 'pinning provider returned 503' }),
    };
    const submit = jest.fn();
    const { result } = renderHook(() => useDeliverableUpload({ storage, submit }));
    await act(async () => {
      await result.current.upload(file, 'm1');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatchObject({
      stage: 'pin',
      message: 'Could not pin the file to IPFS: pinning provider returned 503',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the CID after a submission failure and retries without re-uploading', async () => {
    const storage = steppedUploader();
    const submit = jest
      .fn()
      .mockRejectedValueOnce(new Error('backend 500'))
      .mockResolvedValue('ok');
    const { result } = renderHook(() => useDeliverableUpload({ storage, submit }));

    await act(async () => {
      await result.current.upload(file, 'm1');
    });
    expect(result.current.error).toMatchObject({
      stage: 'submit',
      message: 'Submission failed: backend 500',
    });
    expect(result.current.cid).toBe(CID);

    await act(async () => {
      await result.current.retrySubmit();
    });
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('success');
  });

  it('fails clearly instead of hanging when pinning never finishes', async () => {
    jest.useFakeTimers();
    try {
      const storage: DeliverableUploader = {
        upload: (_f, options = {}) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      };
      const { result } = renderHook(() =>
        useDeliverableUpload({ storage, submit: jest.fn(), pinTimeoutMs: 5_000 }),
      );
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = result.current.upload(file, 'm1');
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await pending;
      });
      expect(result.current.error).toMatchObject({ stage: 'pin' });
      expect(result.current.error?.message).toMatch(/timed out after 5s/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel aborts the in-flight pin and ignores its late result', async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    const storage: DeliverableUploader = {
      upload: async (_f, options = {}) => {
        signal = options.abortSignal;
        await new Promise<void>((r) => (finish = r));
        return { ok: true, data: { cid: CID, url: 'u' } };
      },
    };
    const submit = jest.fn();
    const { result } = renderHook(() => useDeliverableUpload({ storage, submit }));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.upload(file, 'm1');
    });
    act(() => result.current.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish();
      await pending;
    });
    expect(result.current.status).toBe('idle');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('IPFSStorage.upload progress', () => {
  it('maps HTTP upload progress to fractions', async () => {
    const storage = new IPFSStorage({ apiUrl: 'https://pin.example/upload' });
    const http = (storage as unknown as { http: { post: jest.Mock } }).http;
    http.post = jest.fn(async (_url, _body, config) => {
      config.onUploadProgress({ loaded: 2, total: 4 });
      config.onUploadProgress({ loaded: 4 }); // total unknown -> falls back to body size
      return { data: { cid: CID } };
    });
    const progress: unknown[] = [];

    const result = await storage.upload(file, { onUploadProgress: (p) => progress.push(p) });

    expect(result.ok).toBe(true);
    expect(progress).toEqual([
      { loaded: 2, total: 4, fraction: 0.5 },
      { loaded: 4, total: 4, fraction: 1 },
    ]);
  });

  it('does not pass a progress handler when none is requested', async () => {
    const storage = new IPFSStorage({ apiUrl: 'https://pin.example/upload' });
    const http = (storage as unknown as { http: { post: jest.Mock } }).http;
    http.post = jest.fn(async () => ({ data: { cid: CID } }));
    await storage.upload(file);
    expect(http.post.mock.calls[0][2]).not.toHaveProperty('onUploadProgress');
  });
});
