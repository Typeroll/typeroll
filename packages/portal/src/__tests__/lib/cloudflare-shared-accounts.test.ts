import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, disconnect, getConnection, saveConnection, sealCredentials } from '../../lib/publishing/connections';
import {
  assertTrafficNotOwnedByOtherOrganization, claimCloudflareResource, cloudflareAccountAccess, cloudflareAccountMembers, cloudflareClaimPath, cloudflareResourceOwner,
  generatedCloudflareNames, isSharedCloudflareAccount, joinCloudflareAccount, mediaTransferWorkerName, withCloudflareAccountMembership,
} from '../../lib/publishing/cloudflare-account-claims';
import { CLOUDFLARE_SCOPES, cloudflareChoices, finishCloudflareConnection, selectCloudflareAccount, startCloudflareConnection } from '../../lib/publishing/cloudflare-oauth';
import { cloudflareOrganizationView, composeCloudflareDiagnosis, currentCloudflareDiagnosis } from '../../lib/publishing/cloudflare-diagnosis';
import { connectCloudflare, prepareCloudflareMedia } from '../../lib/publishing/cloudflare-connection';
import { updateHostingConnection } from '../../lib/publishing/hosting-connection';
import { saveHostingGroup } from '../../lib/publishing/hosting-groups';

const account = { id: 'a'.repeat(32), name: 'Shared Account' };
const owner = { userId: 'owner-of-both', email: 'owner@example.invalid' };
const token = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', scope: CLOUDFLARE_SCOPES.join(' ') };
const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-secret');
  const store = getStore();
  await store.setDoc('organizations/company-a', { name: 'Company A' });
  await store.setDoc('organizations/company-b', { name: 'Company B' });
  await store.setDoc('organizations/company-c', { name: 'Company C' });
  // One owner with several companies; another person administers only Company B; a third is only an editor of Company A.
  await store.setDoc('organizations/company-a/members/owner-of-both', { role: 'owner' });
  await store.setDoc('organizations/company-b/members/owner-of-both', { role: 'admin' });
  await store.setDoc('organizations/company-b/members/admin-of-b', { role: 'admin' });
  await store.setDoc('organizations/company-a/members/editor-of-a', { role: 'editor' });
  await store.setDoc('organizations/company-b/members/editor-of-a', { role: 'owner' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Company A uses the account: its Default connection is connected and it is a member. */
async function companyAConnected(options: { legacy?: boolean } = {}) {
  await getStore().setDoc(connectionPath('company-a', 'cloudflare'), { status: 'connected', revision: 'a-revision', auth_method: 'api_token',
    cloudflare: { account_id: account.id, account_name: account.name, bucket: 'company-a-originals', public_bucket: 'company-a-public', endpoint: '' },
    encrypted_credentials: sealCredentials('company-a', 'cloudflare', { api_token: 'synthetic-a' }) });
  if (options.legacy) await getStore().setDoc(cloudflareClaimPath(account.id), { org_id: 'company-a' });
  else await joinCloudflareAccount({ orgId: 'company-a', userId: 'owner-of-both' }, account.id, 'default');
}

function cloudflare(accounts = [account]) {
  return vi.fn<typeof fetch>(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/oauth2/token') return Response.json(token);
    if (path === '/client/v4/accounts') return Response.json({ success: true, result: accounts });
    if (path.endsWith('/pages/projects')) return Response.json({ success: true, result: [] });
    const found = accounts.find(item => path === `/client/v4/accounts/${item.id}`);
    if (found) return Response.json({ success: true, result: found });
    if (path.endsWith('/domains/managed')) return Response.json({ success: true, result: { enabled: false } });
    if (path.endsWith('/domains/custom')) return Response.json({ success: true, result: { domains: [] } });
    throw new Error(`Unexpected provider request ${path}`);
  });
}
async function signIn(session: { orgId: string; userId: string; email: string }, fetcher = cloudflare()) {
  const started = await startCloudflareConnection(session);
  return finishCloudflareConnection(session, { browser: started.browser, code: 'synthetic-code', state: new URL(started.url).searchParams.get('state')! }, fetcher);
}
function r2() {
  let stored = '';
  return vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) { stored = command.input.Body as string; return {}; }
    if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => stored } };
    if (command instanceof DeleteObjectCommand) return {};
    throw new Error('Unexpected S3 operation');
  }) as any);
}

describe('joining a Cloudflare account another Organization uses', () => {
  it('lets a person who administers an Organization using it join after a confirmation naming it', async () => {
    await companyAConnected();
    const session = { ...owner, orgId: 'company-b' };
    // One authorized account is still offered as a choice, so that the person confirms sharing it.
    expect(await signIn(session)).toBe('select');
    expect(await cloudflareChoices(session)).toEqual([{ ...account, shared_with: ['Company A'] }]);
    expect((await currentCloudflareDiagnosis('company-b', 'default', session)).accounts).toMatchObject([{ id: account.id, usable: true, shared_with: ['Company A'] }]);
    await expect(selectCloudflareAccount(session, account.id, cloudflare())).rejects.toMatchObject({
      code: 'shared_account_confirmation_required', status: 409, details: { shared_with: ['Company A'] } });
    // Asking for the confirmation leaves the choice open.
    expect(await cloudflareChoices(session)).toHaveLength(1);
    await selectCloudflareAccount(session, account.id, cloudflare(), 'default', { confirmShared: true });
    expect(await getConnection('company-b', 'cloudflare')).toMatchObject({ status: 'connected', cloudflare: { account_id: account.id } });
    expect((await cloudflareAccountMembers(account.id)).map(member => [member.org_id, member.hosting_groups])).toEqual([['company-a', ['default']], ['company-b', ['default']]]);
    expect(await getStore().getDoc(cloudflareClaimPath(account.id))).toMatchObject({ schema: 2, org_id: 'company-a' });
    // Other admins of Company B see the connection, never which Organizations the joining person administers.
    expect(JSON.stringify(await currentCloudflareDiagnosis('company-b', 'default'))).not.toContain('Company A');
    expect(JSON.stringify(await currentCloudflareDiagnosis('company-b', 'default', { userId: 'admin-of-b' }))).not.toContain('Company A');
  });

  it('refuses a person who administers no Organization using it, without naming that Organization', async () => {
    await companyAConnected();
    for (const userId of ['admin-of-b', 'editor-of-a']) {
      const session = { userId, email: 'person@example.invalid', orgId: 'company-b' };
      await expect(signIn(session)).rejects.toMatchObject({ code: 'claimed_by_other_organization' });
      const diagnosis = await currentCloudflareDiagnosis('company-b', 'default', session);
      expect(diagnosis.accounts[0]).toMatchObject({ usable: false, blockers: [{ code: 'claimed_by_other_organization', who: 'organization_admin',
        action: { kind: 'link', url: expect.stringContaining('/cloudflare-troubleshooting/#claimed_by_other_organization') } }] });
      expect(JSON.stringify(diagnosis)).not.toMatch(/Company A|company-a/);
      expect(diagnosis.accounts[0].blockers[0].message).toMatch(/owner or admin of an Organization that already uses it.*Typeroll support/);
      expect(await cloudflareAccountAccess(session, account.id)).toEqual({ state: 'refused', shared_with: [], confirmation_required: false });
    }
    expect(await getConnection('company-b', 'cloudflare')).toMatchObject({ status: 'disconnected' });
    expect((await cloudflareAccountMembers(account.id)).map(member => member.org_id)).toEqual(['company-a']);
  });

  it('applies the same rule to API tokens: a person confirms, an API key cannot join', async () => {
    await companyAConnected();
    r2();
    const input = (bucket: string) => ({ account_id: account.id, bucket, api_token: 'synthetic-token', access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret' });
    const revision = async () => (await getConnection('company-b', 'cloudflare')).revision;
    const apiKey = await connectCloudflare({ orgId: 'company-b', userId: 'api-key:abcdef123456', email: '' }, { ...input('company-b-media'), revision: await revision() }, cloudflare()).catch(error => error);
    expect(apiKey).toMatchObject({ code: 'claimed_by_other_organization' });
    expect(apiKey.message).toContain('An API key cannot confirm this');
    expect(apiKey.message).not.toContain('Company A');
    const person = { ...owner, orgId: 'company-b' };
    await expect(connectCloudflare(person, { ...input('company-b-media'), revision: await revision() }, cloudflare()))
      .rejects.toMatchObject({ code: 'shared_account_confirmation_required', details: { shared_with: ['Company A'] } });
    // Two Organizations never share a bucket, not even when the person controls both.
    await expect(connectCloudflare(person, { ...input('company-a-originals'), revision: await revision(), confirm_shared_account: true }, cloudflare()))
      .rejects.toMatchObject({ code: 'cloudflare_resource_owned_by_other_organization' });
    expect(S3Client.prototype.send).not.toHaveBeenCalled();
    await connectCloudflare(person, { ...input('company-b-media'), revision: await revision(), confirm_shared_account: true }, cloudflare());
    expect(await cloudflareResourceOwner(account.id, 'r2_bucket', 'company-b-media')).toBe('company-b');
    expect((await cloudflareAccountMembers(account.id)).map(member => member.org_id)).toEqual(['company-a', 'company-b']);
  });

  it('lets a Hosting Group of a member Organization use the account without asking again', async () => {
    await companyAConnected();
    const group = await saveHostingGroup('company-a', { name: 'Second', sites_domain: 'sites2.example.com', dns_mode: 'automatic' });
    const provider = vi.fn<typeof fetch>(async url => Response.json({ success: true, result: String(url).includes('/pages/') ? [] : account }));
    await updateHostingConnection('company-a', { hosting_group_id: group.id, revision: (await getConnection('company-a', 'cloudflare', group.id)).revision,
      action: 'connect', account_id: account.id, api_token: 'synthetic-second' }, provider, { userId: 'api-key:abcdef123456' });
    expect((await cloudflareAccountMembers(account.id))[0]).toMatchObject({ org_id: 'company-a', hosting_groups: ['default', group.id] });
    // An API key of another Organization cannot join through a Hosting Group either.
    const other = await saveHostingGroup('company-c', { name: 'Third', sites_domain: 'sites3.example.com', dns_mode: 'automatic' });
    await expect(updateHostingConnection('company-c', { hosting_group_id: other.id, revision: (await getConnection('company-c', 'cloudflare', other.id)).revision,
      action: 'connect', account_id: account.id, api_token: 'synthetic-third' }, provider, { userId: 'api-key:abcdef123456' })).rejects.toMatchObject({ code: 'claimed_by_other_organization' });
  });

  it('undoes a membership it added when the connection is not saved', async () => {
    await companyAConnected();
    await expect(withCloudflareAccountMembership({ orgId: 'company-b', userId: 'owner-of-both' }, account.id, 'default', { confirmed: true },
      async () => { throw new Error('save failed'); })).rejects.toThrow('save failed');
    expect((await cloudflareAccountMembers(account.id)).map(member => member.org_id)).toEqual(['company-a']);
  });
});

describe('leaving a shared Cloudflare account', () => {
  async function bothConnected() {
    await companyAConnected();
    await getStore().setDoc(connectionPath('company-b', 'cloudflare'), { status: 'connected', revision: 'b-revision',
      cloudflare: { account_id: account.id, account_name: account.name, bucket: 'company-b-originals', endpoint: '' }, encrypted_credentials: null });
    await joinCloudflareAccount({ orgId: 'company-b', userId: 'owner-of-both' }, account.id, 'default', { confirmed: true });
  }

  it('removes only the disconnecting Organization and deletes the claim when nobody uses the account', async () => {
    await bothConnected();
    await disconnect('company-b', 'cloudflare', 'b-revision');
    expect((await cloudflareAccountMembers(account.id)).map(member => member.org_id)).toEqual(['company-a']);
    expect(await getConnection('company-a', 'cloudflare')).toMatchObject({ status: 'connected' });
    expect(await isSharedCloudflareAccount('company-a', account.id)).toBe(false);
    await disconnect('company-a', 'cloudflare', 'a-revision');
    expect(await getStore().getDoc(cloudflareClaimPath(account.id))).toBeNull();
    // Ownership records outlive membership: the buckets and projects are still in the account.
    await claimCloudflareResource('company-a', account.id, 'pages_project', 'typeroll-0123456789abcdef');
    expect(await cloudflareResourceOwner(account.id, 'pages_project', 'typeroll-0123456789abcdef')).toBe('company-a');
  });

  it('lets an Organization return to the account its sites already use', async () => {
    await bothConnected();
    await disconnect('company-a', 'cloudflare', 'a-revision');
    // The editor administers Company B only; Company A's connection still names the account, so it may return.
    expect(await cloudflareAccountAccess({ orgId: 'company-a', userId: 'editor-of-a' }, account.id)).toMatchObject({ state: 'returning', confirmation_required: true, shared_with: [{ name: 'Company B' }] });
    expect(await cloudflareAccountAccess({ orgId: 'company-a', userId: 'api-key:abcdef123456' }, account.id)).toEqual({ state: 'returning', shared_with: [], confirmation_required: false });
  });
});

describe('claims written before sharing', () => {
  it('read a single-owner claim as its Organization’s membership and upgrade it on the next write', async () => {
    await companyAConnected({ legacy: true });
    expect(await cloudflareAccountMembers(account.id)).toEqual([{ org_id: 'company-a', hosting_groups: ['default'], joined_at: null, joined_by: null }]);
    expect(await cloudflareAccountAccess({ orgId: 'company-b', userId: 'admin-of-b' }, account.id)).toMatchObject({ state: 'refused' });
    await joinCloudflareAccount({ orgId: 'company-b', userId: 'owner-of-both' }, account.id, 'default', { confirmed: true });
    expect(await getStore().getDoc(cloudflareClaimPath(account.id))).toMatchObject({ schema: 2, legacy_org_id: 'company-a', org_id: 'company-a',
      members: [{ org_id: 'company-a', hosting_groups: ['default'] }, { org_id: 'company-b', hosting_groups: ['default'], joined_by: 'owner-of-both' }] });
    // The older Organization's buckets are recorded as its own before anyone else joins.
    expect(await cloudflareResourceOwner(account.id, 'r2_bucket', 'company-a-originals')).toBe('company-a');
    expect(await cloudflareResourceOwner(account.id, 'r2_bucket', 'company-a-public')).toBe('company-a');
  });

  it('keep working for their own Organization, which reconnects without any confirmation', async () => {
    await companyAConnected({ legacy: true });
    expect(await cloudflareAccountAccess({ orgId: 'company-a', userId: 'editor-of-a' }, account.id)).toEqual({ state: 'member', shared_with: [], confirmation_required: false });
  });

  it('no longer block anyone once their Organization stopped using the account', async () => {
    await companyAConnected({ legacy: true });
    const current = await getConnection('company-a', 'cloudflare');
    await saveConnection('company-a', 'cloudflare', current.revision, { status: 'disconnected', encrypted_credentials: null });
    expect(await cloudflareAccountAccess({ orgId: 'company-c', userId: 'nobody' }, account.id)).toMatchObject({ state: 'first' });
  });
});

describe('isolation inside a shared account', () => {
  it('keeps every generated name unchanged and different for each Organization and Site', () => {
    const a = generatedCloudflareNames('company-a', 'site-1'), b = generatedCloudflareNames('company-b', 'site-1');
    // The names Core has always generated: existing resources are never renamed.
    expect(a).toEqual({ media_bucket: `typeroll-media-${sha('company-a')}`, public_bucket: `typeroll-public-${sha('company-a')}`,
      build_worker: `typeroll-builder-${sha('company-a')}`, build_worker_tag: `typeroll-build-${sha('company-a')}`,
      pages_project: `typeroll-${sha('company-a\0site-1')}`, site_label: `site-${sha('company-a\0site-1')}` });
    for (const key of Object.keys(a) as Array<keyof typeof a>) expect(a[key]).not.toBe(b[key]);
    expect(generatedCloudflareNames('company-a', 'site-2').pages_project).not.toBe(a.pages_project);
    expect(mediaTransferWorkerName('company-a', 'https://cms.example')).toBe(`typeroll-media-${sha('https://cms.example\0company-a')}`);
    expect(mediaTransferWorkerName('company-a', 'https://cms.example')).not.toBe(mediaTransferWorkerName('company-b', 'https://cms.example'));
  });

  it('refuses to operate on a resource recorded for another Organization, whatever its name', async () => {
    await claimCloudflareResource('company-a', account.id, 'pages_project', 'typeroll-0123456789abcdef', { siteId: 'site-1' });
    await claimCloudflareResource('company-a', account.id, 'pages_project', 'typeroll-0123456789abcdef');
    await expect(claimCloudflareResource('company-b', account.id, 'pages_project', 'typeroll-0123456789abcdef'))
      .rejects.toMatchObject({ code: 'cloudflare_resource_owned_by_other_organization', status: 409 });
    await claimCloudflareResource('company-a', account.id, 'worker', generatedCloudflareNames('company-a').build_worker);
    await expect(claimCloudflareResource('company-b', account.id, 'worker', generatedCloudflareNames('company-a').build_worker)).rejects.toMatchObject({ code: 'cloudflare_resource_owned_by_other_organization' });
    // The same name in another account is a different resource.
    await claimCloudflareResource('company-b', 'b'.repeat(32), 'pages_project', 'typeroll-0123456789abcdef');
  });

  it('never prepares media in a bucket another Organization owns', async () => {
    await companyAConnected();
    await getStore().setDoc(connectionPath('company-b', 'cloudflare'), { status: 'connected', revision: 'b-revision', auth_method: 'api_token',
      cloudflare: { account_id: account.id, account_name: account.name, bucket: 'company-a-originals', endpoint: '' },
      encrypted_credentials: sealCredentials('company-b', 'cloudflare', { api_token: 'synthetic-b' }) });
    await claimCloudflareResource('company-a', account.id, 'r2_bucket', 'company-a-originals');
    const fetcher = cloudflare();
    await expect(prepareCloudflareMedia({ ...owner, orgId: 'company-b' }, 'b-revision', fetcher)).rejects.toMatchObject({ code: 'cloudflare_resource_owned_by_other_organization' });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/r2/buckets'))).toBe(false);
  });

  it('never prepares a hostname that serves another Organization’s Pages project for replacement', async () => {
    await claimCloudflareResource('company-a', account.id, 'pages_project', 'typeroll-0123456789abcdef');
    const records = [{ type: 'CNAME', content: 'typeroll-0123456789abcdef.pages.dev' }];
    await expect(assertTrafficNotOwnedByOtherOrganization('company-b', account.id, records)).rejects.toMatchObject({ code: 'hostname_used_by_other_organization' });
    await expect(assertTrafficNotOwnedByOtherOrganization('company-b', account.id, [{ type: 'CNAME', content: 'version-x.typeroll-0123456789abcdef.pages.dev' }])).rejects.toMatchObject({ code: 'hostname_used_by_other_organization' });
    await assertTrafficNotOwnedByOtherOrganization('company-a', account.id, records);
    await assertTrafficNotOwnedByOtherOrganization('company-b', account.id, [{ type: 'CNAME', content: 'unrelated.example.net' }, { type: 'A', content: '192.0.2.1' }]);
  });

  it('keeps the Organizations a person administers out of the organization-level view', () => {
    const diagnosis = composeCloudflareDiagnosis({ groupId: 'default', revision: 'r', attemptedBy: 'owner-of-both', connected: true,
      accounts: [{ ...account, usable: true, blockers: [], shared_with: ['Company A'] }] });
    expect(JSON.stringify(cloudflareOrganizationView(diagnosis))).not.toContain('Company A');
  });
});
