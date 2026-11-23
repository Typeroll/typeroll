import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, type SiteIntegrations, type OrganizationEmailSettings } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { resolveSiteEmailConnector, organizationEmailPath } from '../../lib/email/configuration';
import { readEmailSettings, saveEmailSettings } from '../../lib/email/site-email-settings';
import { organizationEmailSummary, saveOrganizationEmail, removeOrganizationEmail } from '../../lib/email/organization-email';
import { sendApplicationEmail } from '../../lib/email/delivery';
import { queueOptoutPath, queueRecipientDigest } from '../../lib/email/optouts';
import { emailQueueUnsubscribe } from '../../lib/email/queue-unsubscribe';
import { createHash } from 'node:crypto';

vi.mock('../../lib/scheduling/transport', () => ({ deliverCommitted: vi.fn() }));
const org = 'email-org', site = 'site-a';
const connector = { type: 'ses', from: 'Site <site@example.test>', config: {} };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-only-configuration-test-crypto-key');
  await getStore().setDoc(paths.org(org), { name: 'Synthetic organization' });
  await getStore().setDoc(paths.site(org, site), { name: 'Synthetic A', slug: site });
  await getStore().setDoc(paths.integrations(org, site), { email: connector, bulk_email: { daily_limit: 1, minimum_interval_minutes: 1 } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('Site and Organization email configuration', () => {
  it('preserves existing Site accounts and keeps daily campaign settings separate', async () => {
    const before = await resolveSiteEmailConnector(org, site);
    await saveEmailSettings(org, site, { bulk_email: { daily_limit: 12 } });
    expect(await resolveSiteEmailConnector(org, site)).toEqual(before);
    expect(await readEmailSettings(org, site)).toMatchObject({ source: 'site', bulk_email: { daily_limit: 12, minimum_interval_minutes: 1 } });
  });
  it('requires an explicit owning-Organization grant and never falls back after withdrawal', async () => {
    await getStore().setDoc(organizationEmailPath(org), { email: { ...connector, from: 'Organization <org@example.test>' }, allowed_site_ids: [] });
    await expect(saveEmailSettings(org, site, { source: 'organization' })).rejects.toMatchObject({ status: 403 });
    await getStore().updateDoc(organizationEmailPath(org), { allowed_site_ids: [site] });
    await saveEmailSettings(org, site, { source: 'organization' });
    expect((await resolveSiteEmailConnector(org, site))?.from).toContain('org@example.test');
    // The Site keeps its own account, not a copy of the Organization secret.
    expect((await getStore().getDoc<SiteIntegrations>(paths.integrations(org, site)))?.email).toEqual(connector);
    await getStore().updateDoc(organizationEmailPath(org), { allowed_site_ids: [] });
    expect(await resolveSiteEmailConnector(org, site)).toBeNull();
    await saveEmailSettings(org, site, { bulk_email: { daily_limit: 0 } });
    expect((await readEmailSettings(org, site)).bulk_email.daily_limit).toBe(0);
    await saveEmailSettings(org, site, { source: 'site' });
    expect(await resolveSiteEmailConnector(org, site)).toEqual(connector);
  });
  it('uses rotated shared credentials without copying or granting another Site', async () => {
    await getStore().setDoc(organizationEmailPath(org), { email: { ...connector, config: { account: 'old' } }, allowed_site_ids: [site] });
    await saveEmailSettings(org, site, { source: 'organization' });
    await getStore().updateDoc(organizationEmailPath(org), { email: { ...connector, config: { account: 'new' } } });
    expect((await resolveSiteEmailConnector(org, site))?.config).toEqual({ account: 'new' });
    expect(await resolveSiteEmailConnector('another-org', site)).toBeNull();
    await getStore().setDoc(paths.integrations(org, 'new-site'), { email_source: 'organization' });
    expect(await resolveSiteEmailConnector(org, 'new-site')).toBeNull();
  });
  it('gives each Site its own campaign allowance even when both use the same Organization account', async () => {
    await getStore().setDoc(paths.site(org, 'site-b'), { name: 'Synthetic B' });
    await getStore().setDoc(organizationEmailPath(org), { email: connector, allowed_site_ids: [site, 'site-b'] });
    await saveEmailSettings(org, site, { source: 'organization' });
    await saveEmailSettings(org, 'site-b', { source: 'organization', bulk_email: { daily_limit: 1, minimum_interval_minutes: 1 } });
    const send = vi.fn(async () => ({ ok: true as const, id: 'synthetic-provider' }));
    const input = { idempotency_key: 'shared-account-synthetic', to: 'reviewed@example.test', subject: 'Reviewed', text: 'Approved' };
    for (const siteId of [site, 'site-b']) await sendApplicationEmail({ orgId: org, siteId, installationId: 'app-one' }, input, { send, category: 'bulk' });
    expect(send).toHaveBeenCalledTimes(2);
    await expect(sendApplicationEmail({ orgId: org, siteId: site, installationId: 'app-two' }, { ...input, idempotency_key: 'another-shared-request' }, { send, category: 'bulk' })).rejects.toMatchObject({ status: 429 });
  });
  it('stores shared secrets only once, masks them, and refuses stale grant updates', async () => {
    const initial = await organizationEmailSummary(org);
    const saved = await saveOrganizationEmail(org, 'owner-user', { expected_revision: initial.revision, type: 'postmark', from: 'Organization <org@example.test>', config: { server_token: 'synthetic-private-provider-token' } });
    expect(saved.allowed_site_ids).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('synthetic-private-provider-token');
    expect((await getStore().getDoc<OrganizationEmailSettings>(organizationEmailPath(org)))?.email?.config.server_token_enc).toBeTruthy();
    await expect(saveOrganizationEmail(org, 'owner-user', { expected_revision: initial.revision, allowed_site_ids: [site] })).rejects.toMatchObject({ status: 409 });
    const granted = await saveOrganizationEmail(org, 'owner-user', { expected_revision: saved.revision, allowed_site_ids: [site] });
    await expect(saveOrganizationEmail(org, 'owner-user', { expected_revision: granted.revision, allowed_site_ids: ['foreign-site'] })).rejects.toMatchObject({ status: 403 });
    await removeOrganizationEmail(org, 'owner-user', granted.revision);
    expect((await organizationEmailSummary(org)).email).toBeNull();
  });
  it('does not count transactions against the campaign limit or stop them at that limit', async () => {
    const scope = { orgId: org, siteId: site, installationId: 'app-one' };
    const input = { idempotency_key: 'campaign-synthetic-0001', to: 'owner@example.test', subject: 'Review', text: 'Reviewed content' };
    const send = vi.fn(async () => ({ ok: true as const, id: 'synthetic-provider' }));
    await sendApplicationEmail(scope, input, { send, category: 'bulk' });
    await expect(sendApplicationEmail(scope, { ...input, idempotency_key: 'campaign-synthetic-0002' }, { send, category: 'bulk' })).rejects.toMatchObject({ status: 429 });
    await sendApplicationEmail(scope, { ...input, idempotency_key: 'transaction-synthetic-0001' }, { send });
    const date = new Date().toISOString().slice(0, 10);
    expect(await getStore().getDoc(`${paths.site(org, site)}/mail_bulk_quotas/${date}`)).toMatchObject({ total: 1 });
    expect(await getStore().getDoc(`${paths.site(org, site)}/mail_quotas/${date}`)).toMatchObject({ total: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not count transactions toward campaign pacing, while apps share the Site campaign budget', async () => {
    const scope = { orgId: org, siteId: site, installationId: 'app-one' };
    await saveEmailSettings(org, site, { bulk_email: { daily_limit: 2, minimum_interval_minutes: 15 } });
    const send = vi.fn(async () => ({ ok: true as const, id: 'synthetic-provider' }));
    const input = { idempotency_key: 'message-synthetic-0001', to: 'owner@example.test', subject: 'Review', text: 'Reviewed content' };
    await sendApplicationEmail(scope, input, { send, category: 'bulk' });
    await expect(sendApplicationEmail({ ...scope, installationId: 'app-two' }, input, { send, category: 'bulk' })).rejects.toMatchObject({ status: 429, retry_after: expect.any(Number) });
    await sendApplicationEmail({ ...scope, installationId: 'app-two' }, { ...input, idempotency_key: 'transaction-synthetic-0002' }, { send });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('scopes invitation opt-outs without blocking requested edit links', async () => {
    const scope = { orgId: org, siteId: site, installationId: 'app-one' };
    const input = { idempotency_key: 'optout-synthetic-0001', to: 'owner@example.test', subject: 'Review', text: 'Content' };
    await getStore().setDoc(queueOptoutPath(scope, queueRecipientDigest(scope, 'profile-invitations', input.to)), {});
    const send = vi.fn(async () => ({ ok: true as const }));
    await expect(sendApplicationEmail(scope, input, { send, category: 'bulk', deliveryGroup: 'profile-invitations' })).rejects.toMatchObject({ status: 409 });
    await sendApplicationEmail(scope, { ...input, idempotency_key: 'requested-link-synthetic-001' }, { send });
    expect(send).toHaveBeenCalledOnce();
  });
  it('uses a confirmation for unsubscribe GET and never resurrects a deleted Site', async () => {
    const token = 'a'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
    const scope = { orgId: org, siteId: site, installationId: 'app-one' }, recipient = queueRecipientDigest(scope, 'profile-invitations', 'owner@example.test');
    await getStore().setDoc(`mail_queue_unsubscribe/${digest}`, { ...scope, group: 'profile-invitations', recipient_digest: recipient });
    const url = `https://cms.example.test/api/public/email/unsubscribe?t=${token}`;
    expect((await emailQueueUnsubscribe(new Request(url))).status).toBe(200);
    expect(await getStore().getDoc(queueOptoutPath(scope, recipient))).toBeNull();
    expect((await emailQueueUnsubscribe(new Request(url, { method: 'POST', body: new URLSearchParams({ t: token }) }))).status).toBe(200);
    expect(await getStore().getDoc(queueOptoutPath(scope, recipient))).toBeTruthy();
    await getStore().deleteDoc(paths.site(org, site));
    expect((await emailQueueUnsubscribe(new Request(url, { method: 'POST', body: new URLSearchParams({ t: token }) }))).status).toBe(410);
  });
});
