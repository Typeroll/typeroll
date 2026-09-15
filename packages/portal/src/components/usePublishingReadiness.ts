import { useCallback, useEffect, useRef, useState } from 'react';

export interface PublishingSetup {
  ready: boolean;
  mode: 'managed' | 'customer_git';
  required: Array<{ code: string; message: string; settings_url: string }>;
}

/** Fail closed while checking, on errors and when the selected site/version changes. */
export function usePublishingReadiness(siteId: string, enabled = true) {
  const [state, setState] = useState<{ siteId: string; value: PublishingSetup } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async (): Promise<PublishingSetup | null> => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState(null);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/publishing`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok || typeof data.ready !== 'boolean' || !Array.isArray(data.required)) throw new Error('Publishing setup could not be checked. Try again.');
      if (controller.signal.aborted) return null;
      setState({ siteId, value: data });
      return data;
    } catch {
      if (!controller.signal.aborted) setError('Publishing setup could not be checked. Try again.');
      return null;
    }
  }, [siteId]);
  useEffect(() => {
    setState(null);
    if (!enabled) return;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { active.current?.abort(); window.removeEventListener('focus', onFocus); };
  }, [enabled, refresh]);
  return { setup: enabled && state?.siteId === siteId ? state.value : null, error, refresh };
}
