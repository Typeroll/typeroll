// @vitest-environment happy-dom
// The Publishing card's Approve update says, before leaving for Cloudflare,
// that it only grants permission; the Analytics overview changes only the
// Sites a person selects.
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CloudflarePermissionUpdate from '../../components/CloudflarePermissionUpdate';
import OrganizationAnalytics from '../../components/OrganizationAnalytics';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals();
});
const settle = () => act(async () => { for (let step = 0; step < 5; step++) await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (container: Element, name: string) => [...container.querySelectorAll('button')].find(node => node.textContent === name);

function mount(element: ReturnType<typeof createElement>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  return { container, render: () => act(async () => root!.render(element)) };
}

const capability = (capability: string, status: string, missing: string[]) => ({ capability, status, enables: `${capability} enables`, required_scopes: missing, missing_scopes: missing, next_step: null });
const report = (groups = ['default']) => ({
  hosting_group_id: 'default', hosting_group_name: 'Default', connected: true, account_id: 'a'.repeat(32), account_name: 'Moveria AB', auth_method: 'oauth' as const,
  requested_optional_scopes: [], capabilities: [capability('analytics_provisioning', 'approval_required', ['account-settings.write']), capability('analytics_reports', 'available', []),
    capability('redirect_rules', 'approval_required', ['dynamic-redirect.read', 'dynamic-redirect.write'])] as never,
  permission_update: { required: true, missing_scopes: ['account-settings.write'], hosting_group_ids: groups, action: { kind: 'approve_update' as const, label: 'Approve update' as const },
    next_step: 'Approve update', connect_url: 'https://portal.test/app/settings/publishing#cloudflare' },
});

it('confirms that approving grants permission only, then opens Cloudflare for the whole account', async () => {
  const posts: unknown[] = [];
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { posts.push(JSON.parse(String(init!.body))); return Response.json({ authorization_url: 'https://dash.cloudflare.com/oauth2/auth?x=1' }); }));
  const { container, render } = mount(createElement(CloudflarePermissionUpdate, { groupId: 'default', report: report(['default', 'group-2']) }));
  await render();
  const section = container.querySelector('[data-cloudflare-permission-update]')!;
  expect(section.textContent).toContain('Create Web Analytics sites');
  expect(section.textContent).toContain('Create redirect rules');
  expect(section.textContent).not.toContain('Read Analytics reports');

  await act(async () => button(container, 'Approve update')!.click());
  expect(posts).toEqual([]);
  expect(section.textContent).toContain('This only gives Typeroll permission in Moveria AB.');
  expect(section.textContent).toContain('Analytics stays off for every Site until you enable it');
  expect(section.textContent).toContain('once for each of the 2 connections');
  await act(async () => button(container, 'Continue to Cloudflare')!.click());
  await settle();
  expect(posts).toEqual([{ action: 'approve_update' }]);
  expect(assign).toHaveBeenCalledWith('https://dash.cloudflare.com/oauth2/auth?x=1');
});

it('shows nothing when no update is needed', async () => {
  const value = report();
  value.permission_update = { ...value.permission_update, required: false };
  const { container, render } = mount(createElement(CloudflarePermissionUpdate, { groupId: 'default', report: value }));
  await render();
  expect(container.innerHTML).toBe('');
});

it('lists every Site and sends only the Sites whose choice changed', async () => {
  const site = (id: string, enabled: boolean, setup: unknown = null) => ({ site_id: id, name: id.toUpperCase(), publishing_mode: 'customer_git', hosting_group_id: 'default', hosting_group_name: 'Default', enabled, setup, beacon_configured: enabled });
  let sites = [site('alpha', true, { status: 'ready', checked_at: '' }), site('bravo', false), site('charlie', false)];
  const posts: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      sites = sites.map(item => body.sites.some((change: any) => change.site_id === item.site_id) ? site(item.site_id, true, { status: 'action_required', code: 'analytics_host_required', message: 'No address.', next_step: 'Set a host.', checked_at: '' }) : item);
      return Response.json({ results: [{ site_id: 'charlie', enabled: true, status: 'action_required', code: 'analytics_host_required', message: 'No address.', next_step: 'Set a host.' }] });
    }
    return Response.json({ sites, cloudflare_permissions: [report()] });
  }));
  const { container, render } = mount(createElement(OrganizationAnalytics));
  await render(); await settle();
  expect(container.textContent).toContain('1 of 3 Sites measured');
  expect(container.textContent).toContain('turns Analytics on for no Site');
  expect(container.querySelector('[data-analytics-permission="default"] a')?.getAttribute('href')).toBe('https://portal.test/app/settings/publishing#cloudflare');
  expect(button(container, 'No changes')?.disabled).toBe(true);

  const charlie = container.querySelector('[data-analytics-site="charlie"] input') as HTMLInputElement;
  await act(async () => charlie.click());
  await act(async () => button(container, 'Save changes for 1 Site')!.click());
  await settle();
  expect(posts).toEqual([{ sites: [{ site_id: 'charlie', enabled: true }] }]);
  expect(container.querySelector('[data-analytics-site="charlie"]')!.textContent).toContain('Set a host.');
  expect(container.textContent).toContain('1 Site needs an action');
});
