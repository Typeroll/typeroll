import { useState } from 'react';
import type { OrganizationChoice } from '../lib/organization-session';

export default function OrganizationSwitcher({ organizations, currentOrgId }: {
  organizations: OrganizationChoice[]; currentOrgId?: string;
}) {
  const [busy, setBusy] = useState(false);
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
  return <div className="stack" style={{ gap: '0.375rem', minWidth: 0 }}>
    <label htmlFor="active-organization" style={{ fontSize: '0.75rem' }}>Organization</label>
    <select id="active-organization" value={currentOrgId ?? ''} disabled={busy}
      onChange={(event) => void switchTo(event.target.value)}
      style={{ width: '100%', minWidth: 0, color: 'var(--color-text)', background: 'var(--color-bg)', padding: '0.5rem', borderRadius: '0.375rem' }}>
      {!organizations.some((org) => org.id === currentOrgId) && <option value={currentOrgId ?? ''}>{currentOrgId ?? 'Choose organization'}</option>}
      {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
    </select>
    <a href="/onboarding?add=1" style={{ fontSize: '0.75rem', color: 'inherit' }}>Create or join organization</a>
    {error && <p role="alert" style={{ fontSize: '0.75rem' }}>{error}</p>}
  </div>;
}
