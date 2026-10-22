// @vitest-environment happy-dom
// The Analytics module card explains a setup that needs an action, and offers
// renewing the hosting account's Cloudflare consent with Analytics access.
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AppsSettings from '../../components/AppsSettings';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals();
});
const settle = () => act(async () => { for (let step = 0; step < 5; step++) await new Promise(resolve => setTimeout(resolve, 0)); });

const analytics = (setup: Record<string, unknown>) => ({
  id: 'analytics', name: 'Analytics', description: 'Traffic', category: 'insights', affects_build: true,
  fields: [{ key: 'beacon_token', label: 'Token', type: 'text' }],
  state: { enabled: true, config: { beacon_token: '' }, setup },
});

async function render(setup: Record<string, unknown>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const posts: Array<{ url: string; body: any }> = [];
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({ apps: [analytics(setup)] });
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ authorization_url: 'https://dash.cloudflare.com/oauth2/auth?x=1' });
  }));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(AppsSettings, { siteId: 'shop' })));
  await settle();
  return { container, posts, assign };
}

it('shows the cause and next step, and approves Analytics access for the site’s Hosting Group', async () => {
  const { container, posts, assign } = await render({
    status: 'action_required', code: 'analytics_cloudflare_access_required', message: 'Cloudflare needs Account Settings (edit).',
    next_step: 'Select Approve Analytics access.', settings_url: '/app/settings/publishing',
    account: { owner: 'organization', account_id: 'a'.repeat(32), hosting_group_id: 'group-2' },
  });
  const setup = container.querySelector('[data-app-setup="action_required"]')!;
  expect(setup.textContent).toContain('Cloudflare needs Account Settings (edit).');
  expect(setup.textContent).toContain('Select Approve Analytics access.');
  const button = [...setup.querySelectorAll('button')].find(node => node.textContent === 'Approve Analytics access')!;
  await act(async () => button.click());
  await settle();
  expect(posts).toEqual([{ url: '/api/orgs/publishing/cloudflare', body: { action: 'start', analytics_access: true, hosting_group_id: 'group-2' } }]);
  expect(assign).toHaveBeenCalledWith('https://dash.cloudflare.com/oauth2/auth?x=1');
});

it('names the account a ready setup uses', async () => {
  const { container } = await render({ status: 'ready', account: { owner: 'organization', account_id: 'a'.repeat(32), hosting_group_id: 'default' } });
  expect(container.querySelector('[data-app-setup="ready"]')?.textContent).toContain(`your organization’s Cloudflare account (${'a'.repeat(32)})`);
  expect(container.querySelector('[data-app-setup] button')).toBeNull();
});
