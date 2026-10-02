// @vitest-environment happy-dom
// Coming back from GitHub without a callback must never leave a stale or
// confusing card: it checks again by itself and names the one step left.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PublishingGithubConnection, { type GithubPublishingData } from '../../components/PublishingGithubConnection';
import {
  AUTO_RECHECK_INTERVAL_MS, nextStepSummary, personalConnection, primaryReason, returnHint, shouldAutoRecheck,
} from '../../components/github-return';
import type { GithubBlocker, GithubConnectionDiagnosis } from '../../lib/publishing/github-diagnosis';

const githubUser = { id: '78', login: 'bootingbots' };
const install: GithubBlocker = { code: 'no_installation', who: 'you', message: 'The synthetic-publisher GitHub App is not installed on your personal account or on an organization you own. Install it with All repositories access.',
  action: { kind: 'install', label: 'Install the GitHub App', url: 'https://github.com/apps/synthetic-publisher/installations/new' } };
const notOwner: GithubBlocker = { code: 'not_org_owner', who: 'github_owner', message: '@bootingbots is not an owner of Moveria-AB. Only an organization owner can connect it to Typeroll.',
  action: { kind: 'link', label: 'See who owns Moveria-AB', url: 'https://github.com/orgs/Moveria-AB/people?query=role%3Aowner' } };
const setupNote: GithubBlocker = { code: 'setup_url_missing', who: 'publisher', message: 'GitHub did not send you back to Typeroll after the App installation you started here.',
  action: { kind: 'contact_publisher', label: 'What the publisher must change', url: 'https://typeroll.com/docs/guides/github-troubleshooting/#setup_url_missing' } };
const moveria = { installation_id: '35', account: { login: 'Moveria-AB', type: 'Organization' as const, id: '57' }, usable: false, blockers: [notOwner] };
const personal = { installation_id: '36', account: { login: 'bootingbots', type: 'User' as const, id: '78' }, usable: true, blockers: [] };
function diagnosis(extra: Partial<GithubConnectionDiagnosis> = {}): GithubConnectionDiagnosis {
  return { version: 1, checked_at: '2026-10-02T10:00:00.000Z', revision: 'one', attempted_by: 'dev-user', github_user: githubUser, outcome: 'action_required',
    primary_action: install.action!, blockers: [install], installations: [moveria], app: { slug: 'synthetic-publisher', install_url: install.action!.url! }, ...extra };
}
const notInstalled = diagnosis();
const ready = diagnosis({ checked_at: '2026-10-02T10:05:00.000Z', primary_action: { kind: 'sign_in', label: 'Connect @bootingbots' }, blockers: [], installations: [moveria, personal] });
const attempt = { recheck_available: true, installation_started_at: '2026-10-02T10:01:00.000Z' };
const base = { available: true, connected: false, outcome: 'action_required' as const, attempt, returned: null, working: false, lastCheck: null, now: 1_000_000 };

describe('automatic Check again', () => {
  it('runs only with a trusted identity, for a state a check can change, and not again within the interval', () => {
    expect(shouldAutoRecheck(base)).toBe(true);
    expect(shouldAutoRecheck({ ...base, outcome: 'waiting_on_owner', attempt: { ...attempt, installation_started_at: null } })).toBe(true);
    expect(shouldAutoRecheck({ ...base, attempt: { ...attempt, recheck_available: false } })).toBe(false);
    expect(shouldAutoRecheck({ ...base, attempt: undefined })).toBe(false);
    for (const outcome of ['choose', 'connected', 'needs_attention', 'unavailable'] as const) expect(shouldAutoRecheck({ ...base, outcome }), outcome).toBe(false);
    expect(shouldAutoRecheck({ ...base, connected: true })).toBe(false);
    expect(shouldAutoRecheck({ ...base, available: false })).toBe(false);
    expect(shouldAutoRecheck({ ...base, working: true })).toBe(false);
    expect(shouldAutoRecheck({ ...base, lastCheck: base.now - AUTO_RECHECK_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldAutoRecheck({ ...base, lastCheck: base.now - AUTO_RECHECK_INTERVAL_MS })).toBe(true);
    // A failed sign-in is re-checked only while an installation started here, or a setup return, may have changed it.
    expect(shouldAutoRecheck({ ...base, outcome: 'sign_in_required', attempt: { ...attempt, installation_started_at: null } })).toBe(false);
    expect(shouldAutoRecheck({ ...base, outcome: 'sign_in_required' })).toBe(true);
    expect(shouldAutoRecheck({ ...base, outcome: 'retryable_error', attempt: { ...attempt, installation_started_at: null }, returned: 'installation_returned' })).toBe(true);
  });

  it('shows the return hint only while an installation may be waiting to be found', () => {
    expect(returnHint({ connected: false, diagnosis: notInstalled, attempt })).toBe('Back from GitHub? We check automatically — or select Check again.');
    expect(returnHint({ connected: false, diagnosis: notInstalled, attempt: { ...attempt, recheck_available: false } })).toContain('Sign in to GitHub');
    expect(returnHint({ connected: false, diagnosis: notInstalled, attempt: { recheck_available: true, installation_started_at: null }, returned: 'installation_returned' })).toContain('We check automatically');
    expect(returnHint({ connected: false, diagnosis: notInstalled, attempt: { recheck_available: true, installation_started_at: null } })).toBeNull();
    expect(returnHint({ connected: false, diagnosis: ready, attempt })).toBeNull();
    expect(returnHint({ connected: true, diagnosis: notInstalled, attempt })).toBeNull();
    expect(returnHint({ connected: false, diagnosis: notInstalled, attempt, returned: 'install_requested' })).toContain('sent to the organization’s owners');
  });
});

describe('next-step copy', () => {
  it('names the one step left for a ready personal account', () => {
    expect(personalConnection(ready, ready.primary_action)).toBe('bootingbots');
    expect(nextStepSummary('action_required', ready, ready.primary_action, primaryReason(ready.blockers, ready.installations, ready.primary_action)))
      .toBe('GitHub is not connected yet. Connect @bootingbots to finish.');
    // Without a trusted identity the sign-in is named instead.
    const untrusted = { kind: 'sign_in' as const, label: 'Sign in to GitHub to connect @bootingbots' };
    expect(personalConnection(ready, untrusted)).toBeNull();
    expect(nextStepSummary('action_required', ready, untrusted, undefined)).toBe('GitHub is not connected yet. Next: Sign in to GitHub to connect @bootingbots.');
    // Someone else's account is never "ready" for this person.
    expect(personalConnection({ ...ready, github_user: { id: '1', login: 'someone-else' } }, ready.primary_action)).toBeNull();
  });

  it('names the step or who must take it for other reasons', () => {
    expect(nextStepSummary('action_required', notInstalled, install.action!, install)).toBe('GitHub is not connected yet. Next: Install the GitHub App.');
    const member = diagnosis({ primary_action: notOwner.action!, blockers: [] });
    expect(nextStepSummary('action_required', member, notOwner.action!, primaryReason(member.blockers, member.installations, notOwner.action!)))
      .toBe('GitHub is not connected yet. A GitHub organization owner must act first.');
    expect(nextStepSummary('waiting_on_owner', diagnosis({ outcome: 'waiting_on_owner' }), null, undefined)).toBe('Waiting for a GitHub organization owner.');
  });

  it('never makes a publisher note the reason for the next step', () => {
    expect(primaryReason([setupNote], [personal], ready.primary_action)).toBeUndefined();
    expect(primaryReason([setupNote, install], [], install.action!)).toBe(install);
  });
});

describe('GitHub card after returning from GitHub', () => {
  let root: Root | undefined;
  afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  const settle = () => act(async () => { for (let step = 0; step < 5; step++) await new Promise(resolve => setTimeout(resolve, 0)); });
  function data(value: GithubConnectionDiagnosis, extra: Partial<GithubPublishingData> = {}): GithubPublishingData {
    return { github: { status: 'disconnected', revision: 'one', github: null }, github_choices: [], github_diagnosis: value, github_attempt: attempt,
      github_setup: { available: true, app_configured: true, encryption_available: true, app_slug: 'synthetic-publisher', install_url: install.action!.url! }, ...extra };
  }
  async function render(initial: GithubPublishingData, recheckResult: GithubConnectionDiagnosis, returned: string | null = null) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let current = initial;
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      current = { ...current, github_diagnosis: recheckResult };
      return Response.json({ diagnosis: recheckResult });
    }));
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const draw = () => root!.render(createElement(PublishingGithubConnection, { data: current, disabled: false, disconnecting: false, returned,
      onRefresh: async () => draw(), onDisconnect: () => undefined }));
    await act(async () => draw());
    await settle();
    return { container, posts, rerender: async () => act(async () => draw()) };
  }

  it('re-checks once on load and shows Connect @login with its one-line explanation', async () => {
    const { container, posts, rerender } = await render(data(notInstalled), ready);
    expect(posts).toEqual([{ url: '/api/orgs/publishing/github/diagnosis', body: { action: 'recheck' } }]);
    const next = container.querySelector('.github-connection__next')!;
    expect(next.querySelector('[data-github-summary]')?.textContent).toBe('GitHub is not connected yet. Connect @bootingbots to finish.');
    expect([...next.querySelectorAll('button')].map(node => node.textContent)).toContain('Connect @bootingbots');
    expect(next.textContent).not.toContain('Sign in to GitHub to connect');
    expect(next.querySelector('[data-github-primary-hint]')?.textContent).toBe('GitHub asks you to confirm once; you come straight back here.');
    expect(next.querySelector('[data-github-announcement]')?.textContent).toBe('Checked again. GitHub is not connected yet. Connect @bootingbots to finish.');
    expect(container.querySelector('[data-github-step="sign-in"]')?.textContent).toContain('Signed in as @bootingbots');
    // Re-rendering with new data never starts another check by itself.
    await rerender();
    expect(posts).toHaveLength(1);
  });

  it('re-checks when the tab regains focus, at most once per return', async () => {
    const { posts } = await render(data(notInstalled), notInstalled);
    expect(posts).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + AUTO_RECHECK_INTERVAL_MS + 1);
      await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await settle();
      expect(posts).toHaveLength(2);
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await settle();
      expect(posts).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('does not check by itself without a trusted identity, and says what to do instead', async () => {
    const { container, posts } = await render(data(notInstalled, { github_attempt: { recheck_available: false, installation_started_at: attempt.installation_started_at } }), ready);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(posts).toEqual([]);
    expect(container.querySelector('[data-github-return-hint]')?.textContent).toBe('Back from GitHub? Sign in to GitHub so Typeroll can find the installation.');
  });

  it('shows the return hint while the installation started here is pending', async () => {
    const { container } = await render(data(notInstalled), notInstalled);
    expect(container.querySelector('[data-github-return-hint]')?.textContent).toBe('Back from GitHub? We check automatically — or select Check again.');
  });

  it('labels who acts apart from the reason, so it never reads as part of the sentence', async () => {
    const { container } = await render(data(diagnosis({ blockers: [install, setupNote] }), { github_attempt: undefined }), notInstalled);
    const row = container.querySelector('[data-installation="35"]')!;
    const reason = row.querySelector('.github-connection__reason')!;
    expect(reason.querySelector('.github-connection__who')?.textContent).toBe('Who acts: GitHub organization owner');
    expect([...reason.querySelectorAll('p')].map(node => node.textContent)).toEqual(['Who acts: GitHub organization owner', notOwner.message]);
    expect(row.textContent).not.toContain('GitHub organization owner @bootingbots');
    // The publisher note is shown on its own, with its link, and does not replace the next step.
    const note = container.querySelector('[data-github-note="setup_url_missing"]')!;
    expect(note.textContent).toContain('Who acts: Typeroll publisher');
    expect(note.querySelector('a')?.getAttribute('href')).toBe(setupNote.action!.url);
    expect(container.querySelector('[data-github-summary]')?.textContent).toBe('GitHub is not connected yet. Next: Install the GitHub App.');
  });

  it('checks again after a setup return that carried no state, instead of showing the stale result', async () => {
    const { container, posts } = await render(data(notInstalled, { github_attempt: { recheck_available: true, installation_started_at: null } }), ready, 'installation_returned');
    expect(posts).toHaveLength(1);
    expect(container.querySelector('[data-github-summary]')?.textContent).toBe('GitHub is not connected yet. Connect @bootingbots to finish.');
  });

  it('does not check again right after a callback that already produced a result', async () => {
    const { posts } = await render(data(notInstalled), ready, 'action_required');
    expect(posts).toEqual([]);
  });
});
