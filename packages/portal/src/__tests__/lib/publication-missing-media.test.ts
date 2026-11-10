// A publication checks once, before anything goes live, that every media file
// its content references is in the site's media storage. Files whose copy
// failed and was set aside block it with media_missing and a list, unless the
// request accepts publishing without them (accept_missing_media).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths, type Media } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath } from '../../lib/publishing/connections';
import { getOrganizationDomains, organizationDomainConfigPath, saveOrganizationDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { MISSING_MEDIA_LIST_LIMIT, missingMediaReason, publicationMediaManifest, privateMediaReferences } from '../../lib/publishing/media-manifest';
import type { ImportingMedia } from '../../lib/media/import-retry';

const enqueue = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../lib/deploy/queue', async original => ({ ...await original<typeof import('../../lib/deploy/queue')>(), getDeployQueue: () => ({ enqueue }) }));
vi.mock('../../lib/publishing/readiness', async original => ({ ...await original<typeof import('../../lib/publishing/readiness')>(), publishingReadiness: async () => ({ ready: true, mode: 'customer_git', required: [] }) }));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(), requireSiteAccess: async () => ({ ok: true, value: { owner_org_id: 'org', site: { id: 'site' }, versionId: 'main', session: { email: 'owner@example.com' } } }), requirePermission: () => ({ ok: true }) }));
vi.mock('../../lib/api-auth', async original => ({ ...await original<typeof import('../../lib/api-auth')>(), requireApiKey: async (request: Request) => ({ ok: true, value: { request, keyPrefix: 'synthetic', path: '/deploy', orgId: 'org', siteId: 'site', versionId: 'main', permission: 'admin' } }) }));

const account = 'a'.repeat(32);
const privateUrl = (id: string) => `https://cms.example.com/api/sites/site/media/${id}/content`;
const mediaPath = (id: string) => `${paths.media('org', 'site')}/${id}`;
const ready = (id: string) => ({ provider: 'organization_r2' as const, account_id: account, bucket: 'customer-private', key: `private/media/abcdefghij/originals/${id}.png`, generation: 'r', state: 'ready' as const, grant_expires_at: '' });

async function seed(id: string, doc: Partial<ImportingMedia> = {}) {
  await getStore().setDoc(mediaPath(id), { filename: `${id}.png`, mime_type: 'image/png', cdn_url: privateUrl(id), sha256: createHash('sha256').update(id).digest('hex'), size_bytes: 3, storage: ready(id), created_at: '', ...doc });
  return privateUrl(id);
}
/** Set aside by the media migration after the transfer Worker failed every attempt. */
const setAside = { storage: undefined, r2_key: 'legacy/photo.png', migration_failed: true, migration_error: { code: 'media_transfer_unavailable', message: 'The transfer service was interrupted for https://old.example.com/wp-content/uploads/a.png?token=secret', at: '2026-11-01T00:00:00Z' } };
const html = (urls: string[]) => ({ html: urls.map(url => `<img src="${url}">`).join('') });

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); enqueue.mockClear();
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Synthetic', media_id: 'abcdefghij', publishing_mode: 'customer_git', created_at: '' });
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { revision: 'r', status: 'connected', media_ready: true, cloudflare: { account_id: account, bucket: 'customer-private', public_bucket: 'customer-public' } });
  const config = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'demos.example.com', media_host: 'media.example.net', dns_mode: 'external' });
});

describe('missing media classification', () => {
  const base = { id: 'm', filename: 'm.png', cdn_url: privateUrl('m') } as Media;
  it('treats set-aside copies, rejected imports and files without any stored copy as missing', () => {
    expect(missingMediaReason({ ...base, ...setAside } as Media)).toMatchObject({ code: 'media_transfer_unavailable' });
    expect(missingMediaReason({ ...base, source_url: 'https://old.example.com/a.svg', import_rejected: true, import_error: 'Not an SVG document.', import_error_code: 'media_svg_invalid' } as Media))
      .toEqual({ code: 'media_svg_invalid', reason: 'Not an SVG document.' });
    expect(missingMediaReason(base)).toMatchObject({ code: 'media_file_missing' });
    // Exhausted import retries are set aside with the import's own failure.
    expect(missingMediaReason({ ...base, source_url: 'https://old.example.com/a.png', import_pending: true, import_failures: 5, import_retry_at: null, import_error_code: 'media_transfer_timeout', import_error: 'Timed out.', migration_failed: true } as Media))
      .toEqual({ code: 'media_transfer_timeout', reason: 'Timed out.' });
  });
  it('treats uploads, pending copies and imports waiting for a retry as pending', () => {
    expect(missingMediaReason({ ...base, storage: { ...ready('m'), state: 'uploading' } })).toBeNull();
    expect(missingMediaReason({ ...base, r2_key: 'legacy/m.png' })).toBeNull();
    // A retry from Publishing clears import_retry_at while failures still count: the copy is about to run.
    expect(missingMediaReason({ ...base, source_url: 'https://old.example.com/a.png', import_pending: true, import_failures: 3, import_retry_at: null } as Media)).toBeNull();
  });
});

describe('publication media preflight', () => {
  it('blocks with every missing file, the total and only the source host', async () => {
    const ok = await seed('good');
    const a = await seed('lost', { ...setAside, source_url: 'https://old.example.com/wp-content/uploads/lost.png?token=secret' });
    const b = await seed('svg', { storage: { ...ready('svg'), state: 'uploading' }, source_url: 'https://cdn.example.org/x.svg?sig=abc', import_rejected: true, import_error: 'Not an SVG document.', import_error_code: 'media_svg_invalid' });
    const c = await seed('gone', { storage: undefined });
    const error = await publicationMediaManifest('org', 'site', html([ok, a, b, c]), 'site.demos.example.com').catch(caught => caught);
    expect(error).toMatchObject({ status: 409, code: 'media_missing', details: { missing_media_total: 3 } });
    expect(error.message).toContain('3 referenced media file(s) are missing');
    expect(error.message).toContain('accept_missing_media: true');
    expect(error.details.missing_media).toEqual([
      { media_id: 'gone', filename: 'gone.png', source_host: null, code: 'media_file_missing', reason: 'No stored copy of this file exists.' },
      { media_id: 'lost', filename: 'lost.png', source_host: 'old.example.com', code: 'media_transfer_unavailable', reason: 'The transfer service was interrupted for old.example.com' },
      { media_id: 'svg', filename: 'svg.png', source_host: 'cdn.example.org', code: 'media_svg_invalid', reason: 'Not an SVG document.' },
    ]);
    // Neither a path nor a query of a source address is returned: they may carry tokens.
    expect(JSON.stringify(error.details)).not.toMatch(/secret|sig=|wp-content|\/x\.svg/);
  });

  it('caps the list and always reports the total', async () => {
    const urls: string[] = [];
    for (let index = 0; index < MISSING_MEDIA_LIST_LIMIT + 5; index++) urls.push(await seed(`m${String(index).padStart(3, '0')}`, setAside));
    const error = await publicationMediaManifest('org', 'site', html(urls), 'site.demos.example.com').catch(caught => caught);
    expect(error.code).toBe('media_missing');
    expect(error.details.missing_media).toHaveLength(MISSING_MEDIA_LIST_LIMIT);
    expect(error.details.missing_media_total).toBe(MISSING_MEDIA_LIST_LIMIT + 5);
  });

  it('keeps media_migration_pending, with a count, for files that are only on their way', async () => {
    const a = await seed('uploading', { storage: { ...ready('uploading'), state: 'uploading' } });
    const b = await seed('legacy', { storage: undefined, r2_key: 'legacy/b.png' });
    const c = await seed('retrying', { storage: undefined, source_url: 'https://old.example.com/c.png', import_pending: true, import_failures: 2, import_retry_at: '2099-01-01T00:00:00Z' });
    await expect(publicationMediaManifest('org', 'site', html([a, b, c]), 'site.demos.example.com', undefined, { acceptMissingMedia: true }))
      .rejects.toMatchObject({ status: 409, code: 'media_migration_pending', message: expect.stringMatching(/^3 referenced media file\(s\) are still uploading/) });
  });

  it('reports missing files before pending ones and names the pending count', async () => {
    const a = await seed('lost', setAside);
    const b = await seed('uploading', { storage: { ...ready('uploading'), state: 'uploading' } });
    await expect(publicationMediaManifest('org', 'site', html([a, b]), 'site.demos.example.com', undefined, { dryRun: true }))
      .rejects.toMatchObject({ code: 'media_missing', details: { missing_media_total: 1 }, message: expect.stringContaining('1 more referenced media file(s) are still uploading') });
    // Accepting the missing file still waits for the pending one.
    await expect(publicationMediaManifest('org', 'site', html([a, b]), 'site.demos.example.com', undefined, { acceptMissingMedia: true }))
      .rejects.toMatchObject({ code: 'media_migration_pending' });
  });

  it('publishes without accepted missing files, leaves their references empty and warns', async () => {
    const ok = await seed('good');
    const lost = await seed('lost', { ...setAside, variants: [{ width: 400, cdn_url: 'https://cdn.example.com/lost-400.png' }] } as Partial<ImportingMedia>);
    for (const deferReferences of [false, true]) {
      const result = await publicationMediaManifest('org', 'site', { html: `<img src="${ok}"><img src="${lost}" srcset="https://cdn.example.com/lost-400.png 400w">` }, 'site.demos.example.com', undefined, { acceptMissingMedia: true, deferReferences });
      expect(result.manifest!.entries.map(entry => entry.id)).toEqual(['good']);
      expect(result.sourceMedia.map(item => item.id)).toEqual(['good']);
      expect(result.warnings).toEqual([expect.stringMatching(/^Media lost \(lost\.png\) was not published: it is missing from this site's media storage \(media_transfer_unavailable\)/)]);
      const mapping = new Map<string, string>((result.content as any).reference_mapping?.media ?? []);
      if (deferReferences) expect(mapping.get(lost)).toBe('');
      else {
        expect(result.content.html).toMatch(/^<img src="https:\/\/media\.example\.net\/media\/abcdefghij\/[^"]+good\.png"><img src="" srcset=" 400w">$/);
        expect(privateMediaReferences(result.content)).toEqual([]);
      }
    }
  });

  it('summarizes many accepted missing files in one warning', async () => {
    const urls: string[] = [];
    for (let index = 0; index < 25; index++) urls.push(await seed(`m${String(index).padStart(2, '0')}`, setAside));
    const result = await publicationMediaManifest('org', 'site', html(urls), 'site.demos.example.com', undefined, { acceptMissingMedia: true });
    expect(result.manifest!.entries).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/^25 media files were not published because they are missing from this site's media storage: m00, m01, .*m24\./)]);
    expect(result.content.html).toBe('<img src="">'.repeat(25));
  });
});

const { POST: deployApi } = await import('../../pages/api/v1/sites/[siteId]/deploy');
const { POST: deployUi } = await import('../../pages/api/sites/[siteId]/deploy');

describe('deploy request', () => {
  const call = (route: typeof deployApi, body: unknown) => route({ params: { siteId: 'site' }, request: new Request('http://localhost/deploy', { method: 'POST', body: JSON.stringify(body) }), cookies: {}, locals: {} } as any) as Promise<Response>;
  beforeEach(async () => {
    await getStore().setDoc(organizationDomainConfigPath('org'), { revision: 'org', default_domain: null, sites_domain: 'sites.example.com', media_host: null, dns_mode: 'automatic', verified_at: null });
    const hosts = { website_host: 'site.sites.example.com', media_host: null, media_path_prefix: '' };
    await getStore().setDoc(siteDomainConfigPath('org', 'site'), { revision: 'r', desired: hosts, active: hosts, media_aliases: [], dns_mode: 'automatic', state: 'live' });
  });

  it.each([['API/MCP', deployApi], ['UI', deployUi]] as const)('%s stores accept_missing_media only when it is exactly true', async (_label, route) => {
    const accepted = await call(route, { accept_missing_media: true, confirm_live_domains: true });
    expect(accepted.status).toBeLessThan(300);
    const body = await accepted.json();
    const jobId = body.job_id ?? body.jobId;
    expect(await getStore().getDoc(paths.deploy('org', 'site', jobId))).toMatchObject({ accept_missing_media: true });
    if (route === deployApi) expect(body).toMatchObject({ accept_missing_media: true });
    // The portal hands back a running job instead of starting a second one.
    await getStore().updateDoc(paths.deploy('org', 'site', jobId), { status: 'succeeded' });
    const plain = await (await call(route, { accept_missing_media: 'true', confirm_live_domains: true })).json();
    expect(await getStore().getDoc(paths.deploy('org', 'site', plain.job_id ?? plain.jobId))).not.toHaveProperty('accept_missing_media');
  });
});
