// After cutover one publication serves the live custom domain and the old
// temporary address. A deploy is then a production release and needs an
// explicit acknowledgement naming the live domain.

import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { organizationDomainConfigPath, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { generatedCloudflareNames } from '../../lib/publishing/cloudflare-account-claims';
import { publicationTargets } from '../../lib/publishing/publication-targets';

const enqueue = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../lib/deploy/queue', async original => ({ ...await original<typeof import('../../lib/deploy/queue')>(), getDeployQueue: () => ({ enqueue }) }));
// Publishing setup has its own coverage; these tests start from a ready site.
vi.mock('../../lib/publishing/readiness', async original => ({ ...await original<typeof import('../../lib/publishing/readiness')>(), publishingReadiness: async () => ({ ready: true, mode: 'customer_git', required: [] }) }));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(), requireSiteAccess: async () => ({ ok: true, value: { owner_org_id: 'org', site: { id: 'site' }, versionId: 'main', session: { email: 'owner@example.com' } } }), requirePermission: () => ({ ok: true }) }));
vi.mock('../../lib/api-auth', async original => ({ ...await original<typeof import('../../lib/api-auth')>(), requireApiKey: async (request: Request) => ({ ok: true, value: { request, keyPrefix: 'synthetic', path: '/deploy', orgId: 'org', siteId: 'site', versionId: 'main', permission: 'admin' } }) }));

const { POST: deployApi } = await import('../../pages/api/v1/sites/[siteId]/deploy');
const { POST: deployUi } = await import('../../pages/api/sites/[siteId]/deploy');

const TEMPORARY = `${generatedCloudflareNames('org', 'site').site_label}.sites.moveria.com`;
const hosts = (website_host: string) => ({ website_host, media_host: null, media_path_prefix: '' });

async function site(liveHost: string | null) {
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Moveria', publishing_mode: 'customer_git' });
  await getStore().setDoc(organizationDomainConfigPath('org'), { revision: 'org', default_domain: null, sites_domain: 'sites.moveria.com', media_host: null, dns_mode: 'automatic', verified_at: null });
  const active = hosts(liveHost ?? TEMPORARY);
  await getStore().setDoc(siteDomainConfigPath('org', 'site'), { revision: 'r', desired: active, active, media_aliases: [], dns_mode: 'automatic', state: 'live' });
}

const call = (route: typeof deployApi, body: unknown) => route({ params: { siteId: 'site' }, request: new Request('http://localhost/deploy', { method: 'POST', body: JSON.stringify(body) }), cookies: {}, locals: {} } as any) as Promise<Response>;

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  enqueue.mockClear();
});

it('reports the live domain first, then the temporary address, once a site is cut over', async () => {
  await site('moveria.es');
  expect(await publicationTargets('org', 'site')).toEqual({ production: true, live_domains: ['https://moveria.es'], targets: ['https://moveria.es', `https://${TEMPORARY}`] });
  // Branch publications use their own noindexed version address, never the live domain.
  expect(await publicationTargets('org', 'site', 'redesign')).toMatchObject({ production: false, live_domains: [], targets: [expect.stringMatching(/^https:\/\/v-[0-9a-f]{8}-site-[0-9a-f]+\.sites\.moveria\.com$/)] });
});

it('reports only the temporary address before cutover', async () => {
  await site(null);
  expect(await publicationTargets('org', 'site')).toEqual({ production: false, live_domains: [], targets: [`https://${TEMPORARY}`] });
});

it.each([['API/MCP', deployApi], ['UI', deployUi]] as const)('%s refuses a deploy of a cut-over site without confirm_live_domains, naming the live URL', async (_label, route) => {
  await site('moveria.es');
  const refused = await call(route, {});
  expect(refused.status).toBe(409);
  const body = await refused.json();
  expect(body).toMatchObject({ code: 'live_domain_confirmation_required', production: true, live_domains: ['https://moveria.es'], targets: ['https://moveria.es', `https://${TEMPORARY}`], requires_confirmation: true });
  expect(body.error).toContain('https://moveria.es');
  expect(body.error).toContain('confirm_live_domains: true');
  expect(await getStore().listDocs(paths.deploys('org', 'site'))).toEqual([]);
  expect(enqueue).not.toHaveBeenCalled();
  // Anything but literal true is not an acknowledgement.
  expect((await call(route, { confirm_live_domains: 'true' })).status).toBe(409);
});

it('enqueues a confirmed deploy and records the live targets on the job', async () => {
  await site('moveria.es');
  const accepted = await call(deployApi, { confirm_live_domains: true });
  expect(accepted.status).toBe(202);
  const body = await accepted.json();
  expect(body).toMatchObject({ production: true, live_domains: ['https://moveria.es'], targets: ['https://moveria.es', `https://${TEMPORARY}`], dry_run: false });
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ jobId: body.job_id, versionId: 'main', environment: 'production' }));
  expect(await getStore().getDoc(paths.deploy('org', 'site', body.job_id))).toMatchObject({ production: true, live_domains_confirmed: true, targets: ['https://moveria.es', `https://${TEMPORARY}`] });
});

it('lets the portal publish a cut-over site after its confirmation', async () => {
  await site('moveria.es');
  const accepted = await call(deployUi, { environment: 'production', confirm_live_domains: true });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ ok: true, production: true, live_domains: ['https://moveria.es'] });
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('validates a cut-over site with dry_run without confirmation', async () => {
  await site('moveria.es');
  const accepted = await call(deployApi, { dry_run: true });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ dry_run: true, production: true, targets: ['https://moveria.es', `https://${TEMPORARY}`] });
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
});

it.each([['API/MCP', deployApi, 202], ['UI', deployUi, 200]] as const)('%s publishes a site that is not cut over as before, without confirmation', async (_label, route, status) => {
  await site(null);
  const accepted = await call(route, {});
  expect(accepted.status).toBe(status);
  expect(await accepted.json()).toMatchObject({ production: false, live_domains: [], targets: [`https://${TEMPORARY}`] });
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('treats a site with the former managed mode and a live domain as cut over, like any customer-published site', async () => {
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Older', publishing_mode: 'managed', domain: 'moveria.es', domain_status: 'live' });
  expect(await publicationTargets('org', 'site')).toMatchObject({ production: true, live_domains: ['https://moveria.es'] });
  expect(await publicationTargets('org', 'site', 'main', 'staging')).toMatchObject({ production: false, live_domains: [] });
  await getStore().updateDoc(paths.site('org', 'site'), { domain_status: 'pending' });
  expect(await publicationTargets('org', 'site')).toMatchObject({ production: false, live_domains: [] });
});

it('requires the same acknowledgement for a production rebuild workflow', async () => {
  await site('moveria.es');
  const { startSiteWorkflow } = await import('../../lib/workflows/service');
  const start = (config: Record<string, unknown>) => startSiteWorkflow({ orgId: 'org', siteId: 'site', type: 'rebuild_deploy', config, versionId: 'main', createdBy: 'test' });
  await expect(start({ environment: 'production' })).rejects.toMatchObject({ status: 409, code: 'live_domain_confirmation_required', message: expect.stringContaining('https://moveria.es') });
  // A dry_run flag in workflow config is not a way around it: the workflow always uploads.
  await expect(start({ environment: 'production', dry_run: true })).rejects.toMatchObject({ code: 'live_domain_confirmation_required' });
});
