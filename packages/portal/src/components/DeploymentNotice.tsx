import { useState } from 'react';
import { useDeployProgress } from './useDeployProgress';

/** Resume a pending publication on lists that have no publish controls. */
export default function DeploymentNotice({ siteId }: { siteId: string }) {
  const [error, setError] = useState<string | null>(null);
  const { job } = useDeployProgress(siteId, setError);
  if (!job && !error) return null;
  return <p role={error ? 'alert' : 'status'} className="muted">{error ?? job?.verification_message ?? 'Distributing… The link will appear automatically when ready.'}</p>;
}
