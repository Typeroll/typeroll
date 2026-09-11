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
  const request = vi.fn(async (url: string) => Response.json(url.includes('/permissions') ? { revision: 'one', state: 'up_to_date', message: 'Permissions are up to date.' } : data));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingConnections)));
  expect(container.querySelector('label[for="github-organization"]')?.textContent).toBe('Choose a GitHub account');
  expect(container.textContent).toContain('synthetic-person — Personal account');
  expect(container.textContent).toContain('synthetic-company — Organization');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reconnect GitHub to create new repositories');
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === 'Reconnect GitHub')!;
  expect(button).toBeDefined(); expect(button.closest('details')?.open).toBe(true);
  await act(async () => button.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(request.mock.calls.some(([url]) => url === '/api/orgs/publishing/github')).toBe(true);
});
