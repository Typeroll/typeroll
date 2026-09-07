import { useEffect, useState } from 'react';
import type { OrganizationChoice } from '../lib/organization-session';
import './OrganizationSwitcher.css';

export default function OrganizationSwitcher({ organizations, currentOrgId }: {
  organizations: OrganizationChoice[]; currentOrgId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [error, setError] = useState('');
  async function switchTo(orgId: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/orgs/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId }),
      });
      if (!response.ok) throw new Error('Could not switch organization. Reload and try again.');
      window.location.href = '/app';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch organization.');
      setBusy(false);
    }
  }
  return <div className="organization-switcher">
    <div className="organization-switcher__control">
      <label htmlFor="active-organization" className="organization-switcher__label">Organization</label>
      <div className="organization-switcher__current">
        <select id="active-organization" value={currentOrgId ?? ''} disabled={busy || !hydrated}
          onChange={(event) => void switchTo(event.target.value)}>
          {!organizations.some((org) => org.id === currentOrgId) && <option value={currentOrgId ?? ''}>{currentOrgId ?? 'Choose organization'}</option>}
          {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
        <svg className="organization-switcher__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
    <a href="/onboarding?add=1" className="organization-switcher__add">Create or join organization</a>
    {error && <p role="alert" style={{ fontSize: '0.75rem' }}>{error}</p>}
  </div>;
}
