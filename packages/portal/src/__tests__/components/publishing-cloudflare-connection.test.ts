// @vitest-environment happy-dom
// The Cloudflare card must never stop without saying why and what to do next:
// every result is explained inside the card, with one primary action.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PublishingCloudflareConnection from '../../components/PublishingCloudflareConnection';
import {
  CHOICE_EXPIRED, cloudflareDiagnosisAt, cloudflareNextStep, cloudflarePrimaryReason, readCloudflareReturn, resetCloudflareReturn,
} from '../../components/cloudflare-return';
import type { CloudflareBlocker, CloudflareConnectionDiagnosis } from '../../lib/publishing/cloudflare-diagnosis';

const staging = { id: 'a'.repeat(32), name: 'Staging Account' };
const autopilot = { id: 'b'.repeat(32), name: 'Autopilot' };
const disconnected = { status: 'disconnected', revision: 'one', cloudflare: null };
const cancelled: CloudflareBlocker = { code: 'oauth_cancelled', who: 'you', message: 'Cloudflare sign-in was cancelled, so nothing was connected.',
  action: { kind: 'sign_in', label: 'Connect Cloudflare again' } };
const pagesDenied: CloudflareBlocker = { code: 'pages_access_denied', who: 'cloudflare_account_admin', account: staging,
  message: 'Cloudflare refused access to Cloudflare Pages in Staging Account.', action: { kind: 'link', label: 'Open members of Staging Account', url: `https://dash.cloudflare.com/${staging.id}/members` } };
function diagnosis(extra: Partial<CloudflareConnectionDiagnosis> = {}): CloudflareConnectionDiagnosis {
  return { version: 1, checked_at: '2026-10-05T10:00:00.000Z', hosting_group_id: 'default', revision: 'one', attempted_by: 'dev-user', outcome: 'sign_in_required',
    primary_action: { kind: 'sign_in', label: 'Connect Cloudflare' }, blockers: [], accounts: [], selection_expires_at: null, sign_in_started_at: null, recheck_available: false, ...extra };
}
const choose = (expires = Date.now() + 9 * 60_000) => diagnosis({ outcome: 'choose', primary_action: null, recheck_available: true,
  accounts: [{ ...staging, usable: true, blockers: [] }, { ...autopilot, usable: true, blockers: [] }], selection_expires_at: new Date(expires).toISOString() });

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); resetCloudflareReturn();
});
const settle = () => act(async () => { for (let step = 0; step < 5; step++) await new Promise(resolve => setTimeout(resolve, 0)); });

async function render(props: { diagnosis?: CloudflareConnectionDiagnosis; choices?: Array<{ id: string; name: string }>; connection?: typeof disconnected | Record<string, unknown>;
  returned?: string | null; responses?: Record<string, unknown> }) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const posts: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    posts.push({ url, body });
    return Response.json(props.responses?.[`${url}:${body.action}`] ?? {});
  }));
  const refreshes: number[] = [];
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(PublishingCloudflareConnection, { groupId: 'default', connection: (props.connection ?? disconnected) as never,
    diagnosis: props.diagnosis, choices: props.choices ?? [], available: true, returned: props.returned ?? null, onRefresh: async () => { refreshes.push(1); } })));
  await settle();
  const next = container.querySelector('.cloudflare-connection__next')!;
  const buttons = () => [...container.querySelectorAll('button')].map(node => node.textContent);
  return { container, next, posts, refreshes, buttons };
}

describe('Cloudflare card', () => {
  it('offers several authorized accounts in a chooser inside the card, with why and until when', async () => {
    const { container, next, posts } = await render({ diagnosis: choose(), choices: [staging, autopilot], returned: 'choose' });
    const fieldset = next.querySelector('fieldset')!;
    expect(fieldset.querySelector('legend')?.textContent).toBe('Choose a Cloudflare account');
    expect(fieldset.textContent).toContain('You authorized 2 accounts on Cloudflare. Typeroll does not pick one for you');
    expect(fieldset.querySelector('[data-cloudflare-expiry]')?.textContent).toMatch(/^Choose by .+\. After that, check again or connect Cloudflare again\.$/);
    const submit = next.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => { fieldset.querySelector<HTMLInputElement>(`input[value="${autopilot.id}"]`)!.click(); });
    expect(submit.textContent).toBe('Connect Autopilot');
    await act(async () => { submit.click(); });
    await settle();
    expect(posts).toEqual([{ url: '/api/orgs/publishing/cloudflare', body: { action: 'select', account_id: autopilot.id } }]);
    expect(container.querySelector('[data-cloudflare-step="account"]')?.textContent).toContain('Choose one of 2 accounts');
    expect(next.querySelector('[data-cloudflare-announcement]')?.textContent).toContain('Cloudflare connected');
  });

  it('shows why an account cannot be chosen and preselects the only one that can', async () => {
    const { next } = await render({ diagnosis: { ...choose(), accounts: [{ ...staging, usable: false, blockers: [pagesDenied] }, { ...autopilot, usable: true, blockers: [] }] },
      choices: [autopilot] });
    const blocked = next.querySelector(`[data-account="${staging.id}"]`)!;
    expect(blocked.querySelector('input')?.disabled).toBe(true);
    expect(blocked.textContent).toContain('Who acts: Cloudflare account administrator');
    expect(blocked.querySelector('a')?.getAttribute('href')).toBe(pagesDenied.action!.url);
    expect(next.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toBe('Connect Autopilot');
  });

  it('says that a choice expired while the page was open and offers Check again', async () => {
    const { next, posts } = await render({ diagnosis: choose(Date.now() + 300), choices: [staging, autopilot] });
    expect(next.querySelector('fieldset')).not.toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(next.querySelector('fieldset')).toBeNull();
    expect(next.textContent).toContain(CHOICE_EXPIRED);
    const check = [...next.querySelectorAll('button')].find(node => node.textContent === 'Check again')!;
    await act(async () => { check.click(); });
    expect(posts[0]).toEqual({ url: '/api/orgs/publishing/cloudflare/diagnosis', body: { action: 'recheck', hosting_group_id: 'default' } });
  });

  it('keeps a way forward when the server no longer offers the choice', async () => {
    const { next, buttons } = await render({ diagnosis: { ...choose(), recheck_available: false }, choices: [] });
    expect(next.textContent).toContain(CHOICE_EXPIRED);
    expect(buttons()).toContain('Connect Cloudflare again');
  });

  it('explains a cancelled consent inside the card with one primary action', async () => {
    const { container, next, posts } = await render({ diagnosis: diagnosis({ blockers: [cancelled], primary_action: cancelled.action! }), returned: 'sign_in_required' });
    expect(next.querySelector('.cloudflare-connection__who')?.textContent).toBe('Who acts: You');
    expect(next.textContent).toContain(cancelled.message);
    expect([...next.querySelectorAll('.cloudflare-connection__actions > button')].map(node => node.textContent)).toEqual(['Connect Cloudflare again']);
    expect(container.querySelector('[data-cloudflare-step="sign-in"]')?.textContent).toContain('Not completed');
    expect(next.querySelector('[data-cloudflare-announcement]')?.textContent).toContain(cancelled.message);
    expect(document.activeElement).toBe(next);
    await act(async () => { next.querySelector<HTMLButtonElement>('.cloudflare-connection__actions > button')!.click(); });
    expect(posts[0]).toEqual({ url: '/api/orgs/publishing/cloudflare', body: { action: 'start' } });
  });

  it('names the account administrator when Pages access is missing and still lets the person check again or start over', async () => {
    const { container, next, buttons } = await render({ diagnosis: diagnosis({ outcome: 'action_required', primary_action: pagesDenied.action!, recheck_available: true,
      accounts: [{ ...staging, usable: false, blockers: [pagesDenied] }] }) });
    expect(next.querySelector('[data-cloudflare-summary]')?.textContent).toBe('Cloudflare is not connected yet. An administrator of the Cloudflare account must act first.');
    expect(next.querySelector('a.btn')?.getAttribute('href')).toBe(pagesDenied.action!.url);
    expect(buttons()).toEqual(expect.arrayContaining(['Check again', 'Connect Cloudflare again']));
    expect(container.querySelector('[data-cloudflare-step="access"]')?.getAttribute('data-state')).toBe('error');
    expect(container.querySelector('[data-cloudflare-step="account"]')?.textContent).toContain('Only Staging Account was authorized');
  });

  it('explains a return that matched no sign-in from this browser, and an ended Typeroll session', async () => {
    const unmatched = await render({ diagnosis: diagnosis(), returned: 'state_expired' });
    expect(unmatched.next.textContent).toContain('was not started in this browser or has expired, so nothing was changed');
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
    const ended = await render({ diagnosis: diagnosis(), returned: 'session_expired' });
    expect(ended.next.textContent).toContain('Your Typeroll session ended while you were on Cloudflare');
    expect(ended.buttons()).toContain('Connect Cloudflare again');
  });

  it('shows a sign-in in progress and a connected account with Check again', async () => {
    const pending = await render({ diagnosis: diagnosis({ outcome: 'sign_in_pending', sign_in_started_at: '2026-10-05T10:00:00.000Z', primary_action: { kind: 'sign_in', label: 'Start Cloudflare sign-in again' } }) });
    expect(pending.next.querySelector('h3')?.textContent).toBe('Waiting for Cloudflare');
    expect(pending.container.querySelector('[data-cloudflare-step="sign-in"]')?.getAttribute('data-state')).toBe('waiting');
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
    const connected = await render({ connection: { status: 'connected', revision: 'two', cloudflare: { account_id: staging.id, account_name: staging.name } },
      diagnosis: diagnosis({ revision: 'two', outcome: 'connected', primary_action: null, recheck_available: true, accounts: [{ ...staging, usable: true, blockers: [] }] }) });
    expect(connected.next.querySelector('h3')?.textContent).toBe('Cloudflare is ready');
    expect(connected.buttons()).toEqual(['Check again']);
    for (const step of ['publisher', 'sign-in', 'account', 'access', 'connected']) {
      expect(connected.container.querySelector(`[data-cloudflare-step="${step}"]`)?.getAttribute('data-state'), step).toBe('ready');
    }
  });
});

describe('Cloudflare card decisions', () => {
  it('turns an expired choice into an explanation with Check again or a new sign-in', () => {
    const open = choose(Date.now() + 1000);
    expect(cloudflareDiagnosisAt(open, Date.now())).toBe(open);
    expect(cloudflareDiagnosisAt(open, Date.now() + 2000)).toMatchObject({ outcome: 'action_required', primary_action: { kind: 'retry' }, blockers: [{ code: 'account_choice_expired' }] });
    expect(cloudflareDiagnosisAt({ ...open, recheck_available: false }, Date.now(), true)).toMatchObject({ primary_action: { kind: 'sign_in', label: 'Connect Cloudflare again' } });
  });

  it('names the next step or who must take it', () => {
    const cancelledView = diagnosis({ outcome: 'action_required', blockers: [cancelled], primary_action: cancelled.action! });
    expect(cloudflareNextStep(cancelledView, cancelled.action!, cloudflarePrimaryReason(cancelledView, cancelled.action!))).toBe('Cloudflare is not connected yet. Next: Connect Cloudflare again.');
    expect(cloudflareNextStep(diagnosis(), null, undefined)).toContain('Sign in to Cloudflare');
  });

  it('reads the return once for every card and removes it from the address', () => {
    window.history.replaceState(null, '', '/app/settings/publishing?cloudflare=choose&hosting_group=group-1#hosting-group-1');
    expect(readCloudflareReturn()).toEqual({ result: 'choose', groupId: 'group-1' });
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#hosting-group-1');
    expect(readCloudflareReturn()).toEqual({ result: 'choose', groupId: 'group-1' });
    resetCloudflareReturn();
    window.history.replaceState(null, '', '/app/settings/publishing?cloudflare=<script>');
    expect(readCloudflareReturn()).toBeNull();
  });
});
