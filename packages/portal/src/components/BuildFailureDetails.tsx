import type { DeployJob } from '@typeroll/shared';

/**
 * What the failed build step printed, under its one-line error. The engine's
 * own report comes first; the provider's build log is the fallback for engines
 * that predate it. Both are redacted before they are stored.
 */
export function BuildFailureDetails({ failure }: { failure?: Partial<NonNullable<DeployJob['failure']>> | null }) {
  const lines = failure?.diagnostic?.lines?.length ? failure.diagnostic.lines : failure?.provider_log?.lines ?? [];
  if (!lines.length) return null;
  return (
    <details className="build-failure-details text-sm">
      <summary>Build output</summary>
      <pre>{lines.join('\n')}</pre>
      <style>{`
        .build-failure-details { margin-top: 4px; max-width: 100%; }
        .build-failure-details summary { cursor: pointer; color: var(--color-text-muted); }
        .build-failure-details pre { margin: 4px 0 0; padding: 8px; max-height: 18rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
          font-size: 12px; line-height: 1.45; background: var(--color-surface-muted, rgba(127,127,127,0.08)); border-radius: 6px; }
      `}</style>
    </details>
  );
}
