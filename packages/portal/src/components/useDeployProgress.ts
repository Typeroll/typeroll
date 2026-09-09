import { useEffect, useRef, useState } from 'react';

export interface DeployProgress {
  id?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string;
  verification_message?: string | null;
  error?: string;
}

/** Resume an active deploy after navigation; timers and requests end on unmount. */
export function useDeployProgress(siteId: string, onFailure: (message: string) => void, onDeployed?: () => void, canReload = true) {
  const [job, setJob] = useState<DeployProgress | null>(null);
  const [jobId, watch] = useState<string | null>(null);
  const selectedJob = useRef<string | null>(null);
  function selectJob(id: string) { selectedJob.current = id; watch(id); }
  const callbacks = useRef({ onFailure, onDeployed, canReload });
  callbacks.current = { onFailure, onDeployed, canReload };
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/sites/${siteId}/deploy`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (controller.signal.aborted || selectedJob.current) return;
        if (data?.active_job?.id) {
          setJob(data.active_job);
          selectJob(data.active_job.id);
        } else if (data?.latest_job?.status === 'failed') {
          setJob(data.latest_job);
          callbacks.current.onFailure(data.latest_job.error ?? 'Deploy failed');
        }
      }).catch(() => {});
    return () => controller.abort();
  }, [siteId]);
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const response = await fetch(`/api/sites/${siteId}/deploys/${jobId}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Deployment status unavailable');
        const data = await response.json() as DeployProgress;
        if (controller.signal.aborted) return;
        setJob(data);
        if (data.phase === 'distributing') document.documentElement.dataset.typerollDeployment = 'distributing';
        if (data.status === 'succeeded') {
          callbacks.current.onDeployed?.();
          const refresh = () => {
            // A resumed background publication must not discard ongoing edits.
            if (callbacks.current.canReload) window.location.reload();
            else timer = setTimeout(refresh, 1000);
          };
          timer = setTimeout(refresh, 600);
          return;
        }
        if (data.status === 'failed') {
          callbacks.current.onFailure(data.error ?? 'Deploy failed');
          return;
        }
      } catch { /* Transient request failures do not reveal an unverified live link. */ }
      if (!controller.signal.aborted) timer = setTimeout(tick, 3000);
    }
    void tick();
    return () => { controller.abort(); clearTimeout(timer); delete document.documentElement.dataset.typerollDeployment; };
  }, [siteId, jobId]);
  return { job, setJob, watch: selectJob };
}
