// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PublishingGithubPermissions from '../../components/PublishingGithubPermissions';
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(PublishingGithubPermissions, { revision: 'one' })));
  return container;
}
it('opens the existing installation and confirms approval automatically on return without reconnecting', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ revision: 'one', state: 'approval_required', approval_url: 'https://github.com/organizations/synthetic/settings/installations/34', message: 'Approve the requested update.' }))
    .mockResolvedValueOnce(Response.json({ revision: 'one', state: 'up_to_date', approval_url: null, message: 'GitHub permissions are up to date. Your existing connection is active.' }));
  vi.stubGlobal('fetch', request);
  const container = await render(), link = container.querySelector<HTMLAnchorElement>('a')!;
  expect(link.textContent).toContain('Approve GitHub update');
  expect(link.href).toBe('https://github.com/organizations/synthetic/settings/installations/34');
  expect(link.rel).toContain('noopener');
  link.addEventListener('click', event => event.preventDefault());
  await act(async () => { link.click(); window.dispatchEvent(new Event('focus')); });
  expect(request).toHaveBeenCalledTimes(2);
  for (const args of request.mock.calls) expect(args).toEqual(['/api/orgs/publishing/github/permissions', { cache: 'no-store' }]);
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('permissions are up to date');
});
it('explains a publisher-side prerequisite without a misleading approval link and surfaces check failures', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ revision: 'one', state: 'publisher_update_required', approval_url: null, message: 'Typeroll needs to enable GitHub build access. No action is needed from you yet.' }))
    .mockResolvedValueOnce(Response.json({ error: 'GitHub is temporarily unavailable. Try again.' }, { status: 502 }));
  vi.stubGlobal('fetch', request);
  const container = await render();
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).toContain('No action is needed');
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporarily unavailable');
  expect(container.textContent).not.toContain('permissions are up to date');
});
it('does not show confirmation for a different connection revision', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ revision: 'old', state: 'up_to_date', message: 'Incorrect confirmation' })));
  const container = await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('connection changed');
  expect(container.textContent).not.toContain('Incorrect confirmation');
});
