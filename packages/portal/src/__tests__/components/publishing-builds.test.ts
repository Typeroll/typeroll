// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PublishingBuilds from '../../components/PublishingBuilds';
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
it('guides token setup in the right account and rechecks on return without claiming the engine is ready', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const account = 'a'.repeat(32), worker = 'typeroll-builder-123';
  const initial = { state: 'build_token_required', revision: 'one', account_id: account, account_name: 'Build account', worker_name: worker, runner_repo: worker, worker_found: true, enabled: false };
  const request = vi.fn(async (_url: unknown, options?: RequestInit) => Response.json(options?.method === 'POST'
    ? { ...initial, revision: 'two', state: 'qualification_required', issue: { message: 'Build token found. Verification is still required.' } }
    : initial));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  const link = container.querySelector<HTMLAnchorElement>('a.btn')!;
  expect(link.href).toBe(`https://dash.cloudflare.com/${account}/workers/services/view/${worker}/production/settings`);
  expect(link.rel).toContain('noopener');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.textContent).toContain('npm run qualify:artifact');
  // Suppress external navigation while preserving the real click and return handlers.
  link.addEventListener('click', event => event.preventDefault());
  await act(async () => { link.click(); window.dispatchEvent(new Event('focus')); });
  expect(request).toHaveBeenCalledWith('/api/orgs/publishing/builds', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 'one' }) }));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Build token found');
  expect(container.querySelector('section')?.dataset.state).toBe('waiting');
  expect(container.textContent).not.toContain('Shared build engine ready');
  expect(container.querySelector('a.btn')).toBeNull();
});
it('does not direct the user to a missing project', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ state: 'build_token_required', revision: 'one', account_id: 'a'.repeat(32), account_name: 'Build account', worker_name: 'typeroll-builder-123', worker_found: false, enabled: false })));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  expect(container.querySelector('a.btn')).toBeNull();
  expect(container.textContent).toContain('build project has not been found');
});
it('previews a saved GitHub engine without switching providers until the explicit save action', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cloudflare = { provider: 'cloudflare', state: 'ready', enabled: true, revision: 'cf-engine', account_name: 'CF account', worker_name: 'builder' };
  const github = { ...cloudflare, provider: 'github', revision: 'github-engine', account_name: 'Example-Org', worker_name: '' };
  const settings = { ...cloudflare, engines: { cloudflare, github }, selection: { provider: 'cloudflare', revision: 'selection-1' }, active_jobs: [] };
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { ...settings, ...github, selection: { provider: 'github', revision: 'selection-2' } } : settings));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  const select = container.querySelector<HTMLSelectElement>('#build-provider')!;
  await act(async () => { select.value = 'github'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('This engine is ready. Select it below');
  expect(container.textContent).not.toContain('One-time setup in Cloudflare');
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use GitHub Actions for new builds')!;
  await act(async () => { save.click(); });
  expect(request).toHaveBeenLastCalledWith('/api/orgs/publishing/builds', expect.objectContaining({ body: JSON.stringify({ action: 'select', provider: 'github', revision: 'selection-1' }) }));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Saved. New publications will build on GitHub Actions');
  expect(container.textContent).not.toContain('Use GitHub Actions for new builds');
});
