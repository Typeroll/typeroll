import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { sha256 } from '../../lib/builds/contract.mjs';
import { verifyStaticBatch } from '../../lib/builds/publication';
const fixture = vi.hoisted(() => ({ checks: [] as any[], full: null as any[] | null, verify: vi.fn() }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({
  read: async (key: string) => { if (key === 'full' && !fixture.full) throw Error('missing manifest'); return Buffer.from(JSON.stringify(key === 'full' ? fixture.full : fixture.checks)); },
}) }));
vi.mock('../../lib/builds/verification', async importOriginal => ({
  ...await importOriginal<any>(), verifyStaticResponse: (...args: any[]) => fixture.verify(...args),
}));
const jobPath = 'organizations/org/sites/site/deploys/job';
const origin = 'https://site.example.com';
const marker = { route: '/.well-known/typeroll/publication.json', status: 200, sha256: 'a'.repeat(64), size: 40 };
const retired = { route: '/_assets/extensions/se.example.widget/0.2.2/lead-form/index.css', status: 404 };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  fixture.full = null; fixture.verify.mockReset();
  fixture.verify.mockImplementation(async (_origin, check, options) => {
    if (check.status === 200) return true;
    options.observe({ route: check.route, expected_status: 404, actual_status: 200, reason: 'status_mismatch', cf_ray: null });
    return false;
  });
  await getStore().setDoc(jobPath, { status: 'running', verification_message: 'old failure' });
});
it('recovers older saved probe lists without accepting old checkpoint cursors', async () => {
  fixture.checks = [marker, retired];
  await getStore().setDoc(`${jobPath}/build_verifications/${sha256(`checks\0${origin}`)}`, { cursor: 2, complete: true });
  expect(await verifyStaticBatch('org', jobPath, 'checks', origin, true)).toBe(true);
  expect(fixture.verify.mock.calls.map(call => call[1].route)).toEqual([marker.route]);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ verification_message: null, static_probe: null });
});
it('still blocks publication when removed pages or media remain public', async () => {
  for (const route of ['/removed-page/', '/media/removed.jpg']) {
    fixture.checks = [marker, retired, { route, status: 404 }];
    expect(await verifyStaticBatch('org', jobPath, route, origin, true)).toBe(false);
    expect(await getStore().getDoc(jobPath)).toMatchObject({ static_probe: { route, actual_status: 200, expected_status: 404 } });
  }
});


it('recovers in-flight media probes using the full frozen artifact and a fresh policy checkpoint', async () => {
  const source = { route: '/media/photo.jpg', status: 200, sha256: 'b'.repeat(64), size: 900000 };
  const variant = { route: `${source.route}.v1.w640.${'b'.repeat(16)}.avif`, status: 404 };
  fixture.checks = [marker, variant]; fixture.full = [marker, source, variant];
  await getStore().updateDoc(jobPath, { git_publication: { static_checks_key: 'full' }, static_probe: { route: variant.route } });
  await getStore().setDoc(`${jobPath}/build_verifications/${sha256(`checks\0${origin}\0public-v2`)}`, { cursor: 2, complete: true });
  expect(await verifyStaticBatch('org', jobPath, 'checks', origin, true)).toBe(true);
  expect(fixture.verify.mock.calls.map(call => call[1].route)).toEqual([marker.route]);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'running', verification_message: null, static_probe: null });
});

it('does not exempt media probes without evidence from the current artifact', async () => {
  const variant = { route: `/media/photo.jpg.v1.w640.${'b'.repeat(16)}.avif`, status: 404 };
  fixture.checks = [marker, variant];
  expect(await verifyStaticBatch('org', jobPath, 'checks', origin, true)).toBe(false);
  await getStore().updateDoc(jobPath, { git_publication: { static_checks_key: 'full' } });
  await expect(verifyStaticBatch('org', jobPath, 'checks', origin, true)).rejects.toThrow('missing manifest');
});
