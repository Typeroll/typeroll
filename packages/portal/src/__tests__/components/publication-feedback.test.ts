// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DeploymentNotice from '../../components/DeploymentNotice';
import PublishingDomains from '../../components/PublishingDomains';
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function mount(component: ReturnType<typeof createElement>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(component)); return container;
}
it('shows the observed publication failure when a user returns to the page list', async () => {
  const job = { id: 'job', status: 'running', phase: 'waiting for updated static files', verification_message: 'The hosting service still returns HTTP 200 at /removed/; this deployment requires HTTP 404.' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/deploys/') ? job : { active_job: job })));
  const container = await mount(createElement(DeploymentNotice, { siteId: 'synthetic' }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(job.verification_message);
  expect(container.textContent).not.toContain('The link will appear');
});
it('keeps DNS instructions collapsed and confirms the observed domain blocker on refresh', async () => {
  const data = { revision: 'one', dns_mode: 'automatic', state: 'preparing', active: { website_host: 'old.example.com' }, desired: { website_host: 'www.example.com', media_host: null, media_path_prefix: '' }, preparation: { certificate_ready: false, has_existing_traffic: true, validation_blocker: { code: 'domain_prevalidation_unavailable', message: 'Keep the existing DNS records.' }, requirements: [{ phase: 'traffic', type: 'CNAME', name: 'www.example.com', content: 'project.pages.dev', status: 'required' }] } };
  const request = vi.fn(async () => Response.json(data)); vi.stubGlobal('fetch', request);
  const container = await mount(createElement(PublishingDomains, { siteId: 'synthetic' }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Keep the existing DNS records');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('dl')?.textContent).toContain('TypeCNAME');
  expect(container.querySelector('table')).toBeNull();
  const refresh = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Refresh verification')!;
  await act(async () => refresh.click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Checked: the domain transition still needs assistance.');
  expect(request.mock.calls).toHaveLength(2);
});

it('does not show a distributing notice when there is no publication in progress', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ active_job: null, latest_job: null })));
  const container = await mount(createElement(DeploymentNotice, { siteId: 'synthetic' }));
  expect(container.textContent).toBe('');
});
it('retains the latest failed publication message after a fresh page load', async () => {
  const error = 'Publication verification stopped after 45 minutes. HTTP 200 at /removed/; expected HTTP 404.';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ active_job: null, latest_job: { id: 'failed', status: 'failed', error } })));
  const container = await mount(createElement(DeploymentNotice, { siteId: 'synthetic' }));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(error);
});
