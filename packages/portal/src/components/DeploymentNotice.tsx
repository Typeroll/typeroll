import { useState } from 'react';
import { useDeployProgress } from './useDeployProgress';

/** Resume a pending publication on lists that have no publish controls. */
export default function DeploymentNotice({ siteId }: { siteId: string }) {
  const [error, setError] = useState<string | null>(null);
  useDeployProgress(siteId, setError);
  return <p role="status" className="muted">{error ?? 'Distributing… The link will appear automatically when ready.'}</p>;
}
