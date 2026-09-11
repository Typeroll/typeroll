// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ManagedPublishingMigration from '../../components/ManagedPublishingMigration';
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
it('requires a checked plan before migration and confirms saving without claiming deployment', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST' ? { state: 'migrated' } : {
    state: 'ready', revision: 'checked-plan', binding: { project: 'existing-site', website_host: 'www.example.com' }, message: 'Existing hosting stays in place.',
  }));
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(ManagedPublishingMigration, { siteId: 'site' })));
  expect(request).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/sites/site/publishing/managed-migration', { cache: 'no-store' });
  expect(container.textContent).toContain('www.example.com');
  expect(container.querySelector('button')!.textContent).toBe('Migrate this site');
  await act(async () => container.querySelector('button')!.click());
  expect(request).toHaveBeenLastCalledWith('/api/sites/site/publishing/managed-migration', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 'checked-plan' }) }));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Publishing settings saved.');
  expect(container.textContent).toContain('then publish to deploy the new build');
});
it('shows a failed check and cannot submit migration without a verified plan', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Connect the original account.' }, { status: 409 })));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(ManagedPublishingMigration, { siteId: 'site' })));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connect the original account.');
  expect(container.querySelector('button')!.textContent).toBe('Check migration');
});
