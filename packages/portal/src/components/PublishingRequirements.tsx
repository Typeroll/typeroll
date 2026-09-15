import type { PublishingSetup } from './usePublishingReadiness';

export function PublishingRequirements({ setup, error, retry }: {
  setup: PublishingSetup | null; error: string | null; retry: () => void;
}) {
  if (error) return <div role="alert">{error} <button type="button" className="btn btn--secondary btn--sm" onClick={retry}>Check again</button></div>;
  if (!setup) return <span role="status">Checking Publishing setup…</span>;
  if (setup.ready) return null;
  return <div role="status" style={{ flexBasis: '100%', minWidth: 0 }}>
    <p>Publishing setup is incomplete. You can keep editing and use Preview.</p>
    <ul>{setup.required.map(item => <li key={item.code}><a href={item.settings_url} style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '0.15em' }}>{item.message}</a></li>)}</ul>
  </div>;
}
