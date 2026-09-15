// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeployButton } from '../../components/EditorStatus';
import PublishMenu, { PAGE_STATUS_OPTIONS } from '../../components/PublishMenu';
vi.mock('../../components/useDeployProgress', () => ({ useDeployProgress: () => ({ job: null, setJob: vi.fn(), watch: vi.fn() }) }));
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const blocked = { ready: false, mode: 'customer_git', required: [{ code: 'build_engine_update_required', message: 'Update the build engine', settings_url: '/app/settings/publishing#publishing-builds' }] };
for (const surface of ['overview', 'editor'] as const) {
  it(`${surface} blocks loading and missing setup, recovers on focus and rechecks before submitting`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolve!: (response: Response) => void;
    let current = blocked;
    let initial = true;
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/changes-since-deploy')) return Response.json({ changes: [], total: 0, never_deployed: true });
      if (initial) { initial = false; return new Promise<Response>(done => { resolve = done; }); }
      return Response.json(current);
    });
    vi.stubGlobal('fetch', request);
    const confirm = vi.fn(() => true); vi.stubGlobal('confirm', confirm);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(surface === 'overview' ? createElement(DeployButton, { siteId: 'site' }) : createElement(PublishMenu, { siteId: 'site', pubStatus: 'published', statusOptions: PAGE_STATUS_OPTIONS, hasUnsaved: false, onSave: vi.fn(), onDiscard: vi.fn(), onStatusChange: vi.fn() })));
    if (surface === 'editor') await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click());
    const button = () => [...container.querySelectorAll('button')].find(item => /Checking setup|Publishing setup required|Deploy →|Deploy site/.test(item.textContent!))!;
    expect(button().disabled).toBe(true);
    await act(async () => resolve(Response.json(blocked)));
    expect(button().disabled).toBe(true);
    expect(container.querySelector<HTMLAnchorElement>('a[href="/app/settings/publishing#publishing-builds"]')?.style.color).toBe('inherit');
    current = { ...blocked, ready: true, required: [] };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(button().disabled).toBe(false);
    current = blocked;
    await act(async () => button().click());
    expect(confirm).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    expect(request.mock.calls.every(([url]) => !url.endsWith('/deploy'))).toBe(true);
  });
  it(`${surface} fails closed when the check fails and offers retry`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(surface === 'overview' ? createElement(DeployButton, { siteId: 'site' }) : createElement(PublishMenu, { siteId: 'site', pubStatus: 'published', statusOptions: PAGE_STATUS_OPTIONS, hasUnsaved: false, onSave: vi.fn(), onDiscard: vi.fn(), onStatusChange: vi.fn() })));
    if (surface === 'editor') await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click());
    expect(container.textContent).toContain('Publishing setup could not be checked');
    expect([...container.querySelectorAll('button')].find(item => item.textContent === 'Checking setup…')?.disabled).toBe(true);
    expect([...container.querySelectorAll('button')].find(item => item.textContent === 'Check again')).toBeDefined();
  });
}
