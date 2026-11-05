// The local E2E document route reaches every document of the store, so it
// must not exist outside the local E2E Worker (lib/local-e2e.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { authorizeE2EStore, handleE2EStore, isCollectionPath, isDocumentPath } from '../../lib/e2e-store';
import { POST } from '../../pages/api/internal/e2e-store';

const SECRET = 'local-e2e-auth-secret-at-least-32-characters';
const ORIGIN = 'http://127.0.0.1:4322';

function localE2E(): void {
  vi.stubEnv('AUTH_SECRET', '');
  vi.stubEnv('TYPEROLL_LOCAL_E2E', 'allow');
  vi.stubEnv('STORE_JURISDICTION', 'none');
  vi.stubEnv('PORTAL_PUBLIC_URL', ORIGIN);
  vi.stubEnv('TYPEROLL_E2E_AUTH_SECRET', SECRET);
}

const request = (body: unknown, { url = `${ORIGIN}/api/internal/e2e-store`, secret = SECRET } = {}) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-typeroll-e2e-secret': secret }, body: JSON.stringify(body),
});
const call = (req: Request) => (POST as unknown as (context: { request: Request }) => Promise<Response>)({ request: req });

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('local E2E document route', () => {
  it('answers 404 unless local E2E mode is on', async () => {
    localE2E();
    vi.stubEnv('TYPEROLL_LOCAL_E2E', '');
    expect((await call(request({ action: 'get', paths: ['organizations/default'] }))).status).toBe(404);
    localE2E();
    vi.stubEnv('AUTH_SECRET', 'real-auth-secret-0123456789abcdef-0123456789');
    expect((await call(request({ action: 'get', paths: ['organizations/default'] }))).status).toBe(404);
    localE2E();
    vi.stubEnv('STORE_JURISDICTION', 'eu');
    expect((await call(request({ action: 'get', paths: ['organizations/default'] }))).status).toBe(404);
  });

  it('answers 404 to a request that did not reach it on a loopback host', () => {
    localE2E();
    expect(() => authorizeE2EStore(request({}, { url: 'https://app.typeroll.com/api/internal/e2e-store' }))).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('refuses a wrong secret', async () => {
    localE2E();
    expect((await call(request({ action: 'get', paths: ['organizations/default'] }, { secret: 'wrong-e2e-auth-secret-at-least-32-characters' }))).status).toBe(403);
  });

  it('sets, reads, lists and deletes documents', async () => {
    localE2E();
    const page = 'organizations/default/sites/default/versions/main/pages/e2e';
    const set = await call(request({ action: 'set', documents: [{ path: page, data: { id: 'ignored', title: 'E2E' } }, { path: `${page}/revisions/r1`, data: { n: 1 } }] }));
    expect(await set.json()).toEqual({ written: 2 });
    expect(await handleE2EStore({ action: 'get', paths: [page, `${page}-missing`] })).toEqual({ documents: { [page]: { title: 'E2E' }, [`${page}-missing`]: null } });
    expect(await handleE2EStore({ action: 'list', collection: `${page}/revisions` })).toEqual({ documents: [expect.objectContaining({ id: 'r1', n: 1 })] });
    await handleE2EStore({ action: 'delete_tree', paths: [page] });
    expect(await handleE2EStore({ action: 'get', paths: [page, `${page}/revisions/r1`] })).toEqual({ documents: { [page]: null, [`${page}/revisions/r1`]: null } });
  });

  it('accepts only plain store paths', async () => {
    expect(isDocumentPath('organizations/default')).toBe(true);
    expect(isDocumentPath('organizations')).toBe(false);
    expect(isDocumentPath('organizations/../x')).toBe(false);
    expect(isDocumentPath('organizations//x')).toBe(false);
    expect(isCollectionPath('organizations/default/sites')).toBe(true);
    expect(isCollectionPath('organizations/default')).toBe(false);
    localE2E();
    expect((await call(request({ action: 'set', documents: [{ path: '../escape/x', data: {} }] }))).status).toBe(400);
    expect((await call(request({ action: 'set', documents: [{ path: 'organizations/x', data: [] }] }))).status).toBe(400);
    expect((await call(request({ action: 'drop' }))).status).toBe(400);
  });
});
