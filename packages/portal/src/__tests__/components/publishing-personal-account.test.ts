// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PublishingConnections from '../../components/PublishingConnections';
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
it('distinguishes personal choices and exposes reconnect when repository authorization is missing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = { github: { status: 'connected', revision: 'one', github: { owner: 'synthetic-person', account_type: 'User', repository_creation_state: 'reconnect_required' } },
    cloudflare: { status: 'disconnected' }, github_setup: { available: true, install_url: 'https://github.com/apps/synthetic/installations/new' },
    github_choices: [{ owner: 'synthetic-person', installation_id: '34', account_type: 'User' }, { owner: 'synthetic-company', installation_id: '35', account_type: 'Organization' }] };
  const request = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes('/permissions') ? { revision: 'one', state: 'up_to_date', message: 'Permissions are up to date.' } : data));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingConnections)));
  expect(container.querySelector('label[for="github-organization"]')?.textContent).toBe('Choose a GitHub account');
  expect(container.textContent).toContain('synthetic-person — Personal account');
  expect(container.textContent).toContain('synthetic-company — Organization');
  // Renewal is explained in the sign-in step of the card, not in a page-level alert.
  const signIn = container.querySelector('[data-github-step="sign-in"]')!;
  expect(signIn.getAttribute('data-state')).toBe('error');
  expect(signIn.textContent).toContain('Renew authorization');
  expect(signIn.querySelector('details')?.open).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const button = [...signIn.querySelectorAll('button')].find(node => node.textContent === 'Reconnect GitHub')!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(request.mock.calls.some(([url, init]) => url === '/api/orgs/publishing/github' && init?.method === 'POST')).toBe(true);
});

it('reports verified media progress and automatically shows completion without a manual refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const data = { github: { status: 'disconnected' }, github_choices: [], github_setup: { available: false },
    cloudflare: { status: 'connected', revision: 'one', media_ready: true,
      cloudflare: { account_id: 'a'.repeat(32), account_name: 'Test account', bucket: 'private', public_bucket: 'public' } },
    media_migration: { state: 'running', phase: 'copying', copied_files: 1000, pending_files: 0, error: null } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PublishingConnections)));
    expect(container.textContent).toContain('files copied and verified');
    expect(container.textContent).toContain('You can close this page');
    expect(container.textContent).not.toContain('0 remaining');
    data.media_migration = { ...data.media_migration, state: 'complete', copied_files: 1001 };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain('Originals moved to your R2 storage');
    expect(container.textContent).not.toContain('Refresh migration status');
  } finally { vi.useRealTimers(); }
});
