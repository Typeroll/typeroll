// The organization's members and invites. Owners and administrators see
// every member with a role select and remove, and invite people with a role
// (Editor by default). Everyone else sees their own role. The logic lives in
// members-model.ts; the API refuses what the person may not do.

import { useEffect, useId, useState } from 'react';
import { ASSIGNABLE_ROLES, ORGANIZATION_ROLES, type MemberRole } from '@typeroll/shared';
import {
  INVITES_API, initialInviteDraft, inviteBody, inviteProblems, inviteStateLabel, memberApiError, memberName, membersApi,
  roleDescription, roleLabel, roleOptions, shortDate, sortMembers,
  type CreatedInvite, type InviteDraft, type InviteSummary, type OrganizationMember,
} from './members-model';

interface Props {
  orgId: string;
  organizationName?: string;
  currentUserId: string;
  /** The signed-in person's role, when known. */
  currentRole?: MemberRole;
  /** Owners and administrators manage members and invites. */
  canManage: boolean;
  /** Tests start from loaded members and invites. */
  initial?: { members: OrganizationMember[]; invites?: InviteSummary[] };
}

const readJson = async (response: Response) => response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
const thrown = (caught: unknown, fallback: string) => caught instanceof Error ? caught.message : fallback;

export default function OrganizationMembers({ orgId, organizationName, currentUserId, currentRole, canManage, initial }: Props) {
  if (!canManage) {
    return (
      <section className="card stack" style={{ maxWidth: 720 }}>
        <h2 style={{ margin: 0 }}>Your role</h2>
        {currentRole
          ? <p style={{ margin: 0 }}><strong>{roleLabel(currentRole)}</strong> in {organizationName ?? 'this organization'}. <span className="muted">{roleDescription(currentRole)}</span></p>
          : <p className="muted" style={{ margin: 0 }}>Your role in this organization is not known.</p>}
        <p className="muted text-sm" style={{ margin: 0 }}>Owners and administrators manage members and invites.</p>
        <RoleGuide />
        <style dangerouslySetInnerHTML={{ __html: MEMBERS_CSS }} />
      </section>
    );
  }
  return (
    <div className="stack" style={{ maxWidth: 880 }}>
      <MemberList orgId={orgId} currentUserId={currentUserId} currentRole={currentRole} initial={initial?.members} />
      <Invites initial={initial?.invites} skipLoad={Boolean(initial)} />
      <section className="card stack"><h2 style={{ margin: 0 }}>Roles</h2><RoleGuide /></section>
      <style dangerouslySetInnerHTML={{ __html: MEMBERS_CSS }} />
    </div>
  );
}

function RoleGuide() {
  return (
    <dl className="mb-roles">
      {ORGANIZATION_ROLES.map(role => <div key={role}><dt>{roleLabel(role)}</dt><dd>{roleDescription(role)}</dd></div>)}
    </dl>
  );
}

function MemberList({ orgId, currentUserId, currentRole, initial }: { orgId: string; currentUserId: string; currentRole?: MemberRole; initial?: OrganizationMember[] }) {
  const api = membersApi(orgId);
  const [members, setMembers] = useState<OrganizationMember[] | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch(api, { headers: { accept: 'application/json' } }).then(async response => {
      const body = await readJson(response);
      if (!live) return;
      if (!response.ok || !Array.isArray(body?.members)) { setError(memberApiError(body, response.status, 'Loading the members')); setMembers([]); return; }
      setMembers(body!.members as OrganizationMember[]);
    }, caught => { if (live) { setError(thrown(caught, 'Loading the members failed.')); setMembers([]); } });
    return () => { live = false; };
  }, [api]);

  async function changeRole(member: OrganizationMember, role: MemberRole) {
    if (role === member.role) return;
    if (member.id === currentUserId && !confirm(`Change your own role to ${roleLabel(role)}? You may lose access to this page.`)) return;
    setBusy(member.id); setError(null); setNotice(null);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(member.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
      const body = await readJson(response);
      if (!response.ok || !body?.member) { setError(memberApiError(body, response.status, 'Changing the role')); return; }
      const updated = body.member as OrganizationMember;
      setMembers(list => (list ?? []).map(item => item.id === updated.id ? { ...item, ...updated } : item));
      setNotice(`${memberName(member)} is now ${roleLabel(updated.role)}.`);
    } catch (caught) { setError(thrown(caught, 'Changing the role failed.')); }
    finally { setBusy(null); }
  }

  async function remove(member: OrganizationMember) {
    if (!confirm(`Remove ${memberName(member)} from the organization? They lose access to all its sites at once.`)) return;
    setBusy(member.id); setError(null); setNotice(null);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
      const body = await readJson(response);
      if (!response.ok) { setError(memberApiError(body, response.status, 'Removing the member')); return; }
      setMembers(list => (list ?? []).filter(item => item.id !== member.id));
      setNotice(`Removed ${memberName(member)}.`);
    } catch (caught) { setError(thrown(caught, 'Removing the member failed.')); }
    finally { setBusy(null); }
  }

  return (
    <section className="card stack" aria-labelledby="members-title">
      <h2 id="members-title" style={{ margin: 0 }}>Members {members && <span className="muted">({members.length})</span>}</h2>
      {error && <p className="mb-error" role="alert">{error}</p>}
      {notice && <p className="mb-notice" role="status">{notice}</p>}
      {!members ? <p className="muted" role="status">Loading the members…</p>
        : !members.length ? <p className="muted" style={{ margin: 0 }}>No members to show.</p>
        : <ul className="mb-list">{sortMembers(members).map(member => (
          <MemberRow key={member.id} member={member} actorRole={currentRole} self={member.id === currentUserId} busy={busy === member.id} disabled={busy !== null}
            onRole={role => void changeRole(member, role)} onRemove={() => void remove(member)} />
        ))}</ul>}
    </section>
  );
}

function MemberRow({ member, actorRole, self, busy, disabled, onRole, onRemove }: { member: OrganizationMember; actorRole?: MemberRole; self: boolean; busy: boolean; disabled: boolean; onRole: (role: MemberRole) => void; onRemove: () => void }) {
  const id = useId();
  const name = memberName(member);
  return (
    <li className="mb-row">
      <div className="mb-row__who">
        <strong>{name}</strong>{self && <span className="mb-you">You</span>}
        {member.display_name && <span className="muted text-sm">{member.email}</span>}
        {member.joined_at && <span className="muted text-sm">Joined {shortDate(member.joined_at)}</span>}
      </div>
      <div className="mb-row__role">
        <label htmlFor={id} className="mb-sr">Role for {name}</label>
        <select id={id} value={member.role} disabled={disabled} onChange={event => onRole(event.target.value as MemberRole)}>
          {roleOptions(member.role, actorRole).map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
        </select>
        <span className="muted text-sm">{busy ? 'Saving…' : roleDescription(member.role)}</span>
      </div>
      {!self && <button type="button" className="btn btn--secondary" disabled={disabled} onClick={onRemove} aria-label={`Remove ${name}`}>Remove</button>}
    </li>
  );
}

function Invites({ initial, skipLoad }: { initial?: InviteSummary[]; skipLoad: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<InviteDraft>(initialInviteDraft);
  const [invites, setInvites] = useState<InviteSummary[] | null>(initial ?? (skipLoad ? [] : null));
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const problems = inviteProblems(draft);

  async function loadInvites() {
    try {
      const response = await fetch(INVITES_API, { headers: { accept: 'application/json' } });
      const body = await readJson(response);
      setInvites(response.ok && Array.isArray(body?.invites) ? body!.invites as InviteSummary[] : []);
    } catch { setInvites([]); }
  }
  useEffect(() => { if (!skipLoad) void loadInvites(); }, []);

  async function create() {
    setBusy(true); setError(null); setCreated(null); setCopied(false);
    try {
      const response = await fetch(`${INVITES_API}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(inviteBody(draft)) });
      const body = await readJson(response);
      if (!response.ok || typeof body?.inviteUrl !== 'string') { setError(memberApiError(body, response.status, 'Creating the invite')); return; }
      setCreated({ ...(body as unknown as CreatedInvite), role: (body.role as MemberRole | undefined) ?? draft.role });
      setDraft(current => ({ ...current, email: '' }));
      void loadInvites();
    } catch (caught) { setError(thrown(caught, 'Creating the invite failed.')); }
    finally { setBusy(false); }
  }

  async function revoke(invite: InviteSummary) {
    if (!confirm('Revoke this invite? Its link stops working at once; people who already joined stay members.')) return;
    setError(null);
    try {
      const response = await fetch(`${INVITES_API}/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
      const body = await readJson(response);
      if (!response.ok) { setError(memberApiError(body, response.status, 'Revoking the invite')); return; }
      setInvites(list => (list ?? []).map(item => item.id === invite.id ? { ...item, state: 'revoked' } : item));
    } catch (caught) { setError(thrown(caught, 'Revoking the invite failed.')); }
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.inviteUrl); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} style={{ margin: 0 }}>Invite people</h2>
      <p className="muted text-sm" style={{ margin: 0 }}>Create a link and send it yourself. Whoever opens it signed in joins the organization with the role you choose.</p>
      <form className="stack" onSubmit={event => { event.preventDefault(); if (!Object.keys(problems).length) void create(); }}>
        <fieldset className="mb-fieldset">
          <legend>Role</legend>
          {ASSIGNABLE_ROLES.map(role => (
            <label key={role} className="mb-radio">
              <input type="radio" name={`${id}-role`} value={role} checked={draft.role === role} onChange={() => setDraft(current => ({ ...current, role }))} />
              <span><strong>{roleLabel(role)}</strong> <span className="muted text-sm">{roleDescription(role)}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="mb-fields">
          <label>Only for this email <span className="muted">(optional)</span>
            <input type="email" value={draft.email} onChange={event => setDraft(current => ({ ...current, email: event.target.value }))} placeholder="name@example.com" aria-invalid={Boolean(problems.email)} />
            {problems.email && <span className="mb-error">{problems.email}</span>}
          </label>
          <label>Valid for (days)
            <input type="number" min={1} max={30} value={draft.ttlDays} onChange={event => setDraft(current => ({ ...current, ttlDays: Number(event.target.value) }))} aria-invalid={Boolean(problems.ttlDays)} />
            {problems.ttlDays && <span className="mb-error">{problems.ttlDays}</span>}
          </label>
          <label>People who can use it
            <input type="number" min={1} max={50} value={draft.maxUses} onChange={event => setDraft(current => ({ ...current, maxUses: Number(event.target.value) }))} aria-invalid={Boolean(problems.maxUses)} />
            {problems.maxUses && <span className="mb-error">{problems.maxUses}</span>}
          </label>
        </div>
        <div><button type="submit" className="btn" disabled={busy || Object.keys(problems).length > 0}>{busy ? 'Creating…' : 'Create invite link'}</button></div>
      </form>
      {error && <p className="mb-error" role="alert">{error}</p>}
      {created && <div className="mb-notice stack" role="status">
        <p style={{ margin: 0 }}>Invite link for {created.role ? roleLabel(created.role) : 'a member'}{created.email ? `, only for ${created.email}` : ''}. It works until {shortDate(created.expiresAt)}.</p>
        <div className="mb-link"><input readOnly value={created.inviteUrl} aria-label="Invite link" onFocus={event => event.currentTarget.select()} /><button type="button" className="btn btn--secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div>
      </div>}
      {invites && invites.length > 0 && <>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Invites</h3>
        <ul className="mb-list">{invites.map(invite => (
          <li key={invite.id} className="mb-row">
            <div className="mb-row__who">
              <strong>{roleLabel(invite.role)}</strong>
              <span className="muted text-sm">{invite.email ? `For ${invite.email}` : 'Anyone with the link'} · {invite.used_count} of {invite.max_uses} used · until {shortDate(invite.expires_at)}</span>
            </div>
            <span className="mb-state">{inviteStateLabel(invite.state)}</span>
            {invite.state === 'active' && <button type="button" className="btn btn--secondary" onClick={() => void revoke(invite)}>Revoke</button>}
          </li>
        ))}</ul>
      </>}
    </section>
  );
}

const MEMBERS_CSS = `
.mb-roles { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .3rem 1rem; margin: 0; font-size: .9rem; }
.mb-roles > div { display: contents; }
.mb-roles dt { font-weight: 600; }
.mb-roles dd { margin: 0; color: var(--color-text-muted); }
.mb-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.mb-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 16rem) auto; gap: .5rem 1rem; align-items: center; padding: .6rem .75rem; }
.mb-row + .mb-row { border-top: 1px solid var(--color-border); }
.mb-row__who, .mb-row__role { display: grid; gap: .15rem; min-width: 0; overflow-wrap: anywhere; }
.mb-row__role select { width: 100%; }
.mb-you, .mb-state { display: inline-block; justify-self: start; padding: 0 .45rem; border-radius: 999px; border: 1px solid var(--color-border); font-size: .72rem; font-weight: 600; line-height: 1.6; color: var(--color-text-muted); }
.mb-you { margin-left: .4rem; }
.mb-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mb-error { color: var(--color-danger); font-size: .875rem; margin: 0; }
.mb-notice { margin: 0; padding: .6rem .85rem; border-radius: var(--radius-md); border: 1px solid var(--color-success); background: color-mix(in srgb, var(--color-success) 8%, var(--color-surface)); }
.mb-fieldset { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: .75rem 1rem; display: grid; gap: .5rem; margin: 0; min-width: 0; }
.mb-fieldset legend { font-weight: 600; padding: 0 .35rem; }
.mb-radio { display: flex !important; align-items: flex-start; gap: .5rem; cursor: pointer; font-weight: 400; }
.mb-radio input { width: auto; margin-top: 4px; flex-shrink: 0; }
.mb-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .75rem; }
.mb-fields label { display: grid; gap: .25rem; }
.mb-link { display: flex; gap: .5rem; }
.mb-link input { flex: 1; min-width: 0; }
@media (max-width: 640px) {
  .mb-row { grid-template-columns: minmax(0, 1fr); }
  .mb-roles { grid-template-columns: minmax(0, 1fr); }
  .mb-roles dd { margin-bottom: .35rem; }
}
`;
