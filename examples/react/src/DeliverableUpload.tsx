import { useMemo, useState } from 'react';
import { IPFSStorage } from '@trustflow/sdk';
import { useDeliverableUpload } from '@trustflow/sdk/react';

const apiUrl = import.meta.env.VITE_TRUSTFLOW_API_URL ?? 'http://localhost:3000';
const ipfsApiUrl = import.meta.env.VITE_IPFS_API_URL;

/**
 * Pins a file to IPFS with live upload progress, then records the CID against
 * a milestone. `submit` is your own call: here, a POST to the backend.
 */
export function DeliverableUpload() {
  const storage = useMemo(() => new IPFSStorage({ apiUrl: ipfsApiUrl }), []);
  const [milestoneId, setMilestoneId] = useState('1');

  const { upload, retrySubmit, cancel, status, progress, error, cid } = useDeliverableUpload({
    storage,
    submit: async ({ cid, milestoneId }) => {
      const res = await fetch(`${apiUrl}/milestones/${milestoneId}/deliverables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid }),
      });
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      return res.json();
    },
  });

  const busy = status === 'pinning' || status === 'submitting';

  return (
    <section>
      <h2>Submit a deliverable</h2>
      <label>
        Milestone <input value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} />
      </label>
      <input
        type="file"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file, milestoneId);
        }}
      />

      {status === 'pinning' && (
        <p>
          Pinning to IPFS… <progress value={progress ?? undefined} max={1} />{' '}
          {progress !== null && `${Math.round(progress * 100)}%`}{' '}
          <button onClick={cancel}>Cancel</button>
        </p>
      )}
      {status === 'submitting' && <p>Pinned {cid}. Submitting…</p>}
      {status === 'success' && (
        <p>
          Submitted {cid} for milestone {milestoneId}.
        </p>
      )}

      {error?.stage === 'pin' && (
        <p role="alert">{error.message}. Choose the file again to retry.</p>
      )}
      {error?.stage === 'submit' && (
        <p role="alert">
          {error.message}. The file is already pinned as {cid}.{' '}
          <button onClick={() => void retrySubmit()}>Retry submission</button>
        </p>
      )}
    </section>
  );
}
