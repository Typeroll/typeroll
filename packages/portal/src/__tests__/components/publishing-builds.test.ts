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
it('offers setup as the next action and switches to automatic test progress after starting', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial = { provider: 'cloudflare', state: 'qualification_required', revision: 'one', enabled: false, worker_name: 'builder', issue: { code: 'build_qualification_required', message: 'Build token found.' } };
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { ...initial, issue: { code: 'build_verification_running', message: 'Verifying execution.' } } : initial));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons[0].textContent).toBe('Finish build setup');
  expect(container.textContent).toContain('run a test build automatically');
  expect(container.textContent).not.toContain('Build token found');
  await act(async () => { buttons[0].click(); });
  expect(request).toHaveBeenLastCalledWith('/api/orgs/publishing/builds', expect.objectContaining({ body: JSON.stringify({ action: 'setup', revision: 'one' }) }));
  expect(container.textContent).toContain('You can leave this page');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Finish build setup')).toBe(false);
  expect(container.querySelector('section')?.dataset.state).toBe('waiting');
});
it('replaces setup progress with the permission action returned by preflight', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial = { provider: 'cloudflare', state: 'not_configured', revision: 'initial', enabled: false, worker_name: 'builder' };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { ...initial, revision: 'denied', state: 'approval_required', issue: { code: 'build_permission_required', message: 'Click Approve build permissions to allow Workers Builds.' } } : initial)));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Finish build setup')!.click(); });
  expect(container.textContent).not.toContain('Preparing the shared build engine');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Click Approve build permissions');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Approve build permissions' && !b.disabled)).toBe(true);
  expect(container.querySelector('section')?.dataset.state).toBe('error');
});
it('clears failed setup progress and reloads the saved revision before retrying', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial = { provider: 'cloudflare', state: 'ready', revision: 'one', enabled: true, worker_name: 'builder' };
  let failed = false;
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { failed = true; return Response.json({ error: 'Build storage could not be prepared.' }, { status: 502 }); }
    return Response.json(failed ? { ...initial, state: 'error', enabled: false, revision: 'two', issue: { message: 'Build storage could not be prepared.' } } : initial);
  });
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingBuilds)));
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Update build engine')!.click(); });
  expect(container.textContent).not.toContain('Preparing the shared build engine');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Build storage could not be prepared.');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('section')?.dataset.state).toBe('error');
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Finish build setup')!.click(); });
  expect(JSON.parse(request.mock.calls.filter(([, init]) => init?.method === 'POST')[1][1]!.body as string).revision).toBe('two');
});
