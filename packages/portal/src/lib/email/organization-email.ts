import { paths, isArchivedSite, type OrganizationEmailSettings, type Site } from '@typeroll/shared';
import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { readOrganizationAccess } from '../organization-access';
import { buildConnector, maskConnector } from './connector-config';
import { providerDescriptors, sendViaConnector } from './index';
import { resolveSmtpHost, SmtpConfigError } from './providers/smtp';
import { organizationEmailPath, emailSettingsRevision } from './configuration';

export class OrganizationEmailError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export async function organizationEmailSummary(orgId: string) {
  const store = getStore(), saved = await store.getDoc<OrganizationEmailSettings>(organizationEmailPath(orgId));
  const access = await readOrganizationAccess(orgId);
  const sites = await store.listDocs<Site>(paths.sites(orgId));
  return { revision: emailSettingsRevision(saved), email: maskConnector(saved?.email), allowed_site_ids: saved?.allowed_site_ids ?? [],
    sites: sites.filter(site => !isArchivedSite(site)).map(site => ({ id: site.id, name: site.name })),
    own_smtp_required: access.own_smtp, providers: providerDescriptors().filter(provider => !access.own_smtp || provider.type === 'smtp'), crypto_configured: isSecretCryptoConfigured() };
}
/** Caller must establish the live organization-owner role, including API key ownership. */
export async function saveOrganizationEmail(orgId: string, actor: string, body: Record<string, unknown>) {
  if (body.type === undefined && [body.from, body.reply_to, body.config].some(value => value !== undefined)) throw new OrganizationEmailError('Supply the provider type when changing account details');
  if (body.type !== undefined && !isSecretCryptoConfigured()) throw new OrganizationEmailError('Encrypted email storage is not configured', 503);
  const store = getStore(), path = organizationEmailPath(orgId), current = await store.getDoc<OrganizationEmailSettings>(path);
  if (typeof body.expected_revision !== 'string' || body.expected_revision !== emailSettingsRevision(current)) throw new OrganizationEmailError('Organization email settings changed. Reload before saving.', 409);
  let sites = current?.allowed_site_ids ?? [];
  if (body.allowed_site_ids !== undefined) {
    if (!Array.isArray(body.allowed_site_ids) || body.allowed_site_ids.length > 1000 || body.allowed_site_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new OrganizationEmailError('Choose explicit owned sites');
    sites = [...new Set(body.allowed_site_ids as string[])];
    for (const siteId of sites) {
      const site = await store.getDoc<Site>(paths.site(orgId, siteId));
      if (!site || isArchivedSite(site)) throw new OrganizationEmailError('Only active sites owned by this organization can use its mail account', 403);
    }
  }
  let connector = current?.email;
  if (body.type !== undefined) {
    if ((await readOrganizationAccess(orgId)).own_smtp && body.type !== 'smtp') throw new OrganizationEmailError('During the trial, use the organization’s own SMTP account');
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new OrganizationEmailError('Use an object for provider settings');
    const built = buildConnector(String(body.type), String(body.from ?? ''), body.reply_to != null ? String(body.reply_to) : undefined, body.config as Record<string, unknown>, connector);
    if (typeof built === 'string') throw new OrganizationEmailError(built);
    if (built.type === 'smtp') try { await resolveSmtpHost(String(built.config.host ?? '')); }
      catch (error) { throw new OrganizationEmailError(error instanceof SmtpConfigError ? error.message : 'SMTP host is not allowed'); }
    connector = built;
  }
  const candidate: OrganizationEmailSettings = { ...(connector ? { email: connector } : {}), allowed_site_ids: sites, updated_at: new Date().toISOString(), updated_by: actor };
  if (!await store.compareAndReplaceDoc(path, current, candidate, [{ path: `organizations/${orgId}/email_audit/${randomUUID()}`, expected: null,
    data: { action: 'save_email_settings', actor, site_ids: sites, account_changed: body.type !== undefined, at: candidate.updated_at } }])) throw new OrganizationEmailError('Organization email settings changed. Reload before saving.', 409);
  return organizationEmailSummary(orgId);
}
export async function removeOrganizationEmail(orgId: string, actor: string, expected: unknown) {
  const store = getStore(), path = organizationEmailPath(orgId), current = await store.getDoc<OrganizationEmailSettings>(path);
  if (typeof expected !== 'string' || expected !== emailSettingsRevision(current)) throw new OrganizationEmailError('Organization email settings changed. Reload before disconnecting.', 409);
  if (!await store.compareAndReplaceDoc(path, current, { allowed_site_ids: [], updated_at: new Date().toISOString(), updated_by: actor }, [{ path: `organizations/${orgId}/email_audit/${randomUUID()}`, expected: null,
    data: { action: 'disconnect_email', actor, at: new Date().toISOString() } }])) throw new OrganizationEmailError('Organization email settings changed. Reload before disconnecting.', 409);
  return organizationEmailSummary(orgId);
}

export async function testOrganizationEmail(orgId: string, to: unknown) {
  if (typeof to !== 'string' || to.length > 254 || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(to)) throw new OrganizationEmailError('Enter one test recipient');
  const account = await getStore().getDoc<OrganizationEmailSettings>(organizationEmailPath(orgId));
  if (!account?.email) throw new OrganizationEmailError('Configure an organization email account first');
  if ((await readOrganizationAccess(orgId)).own_smtp && account.email.type !== 'smtp') throw new OrganizationEmailError('Use your own SMTP account during the trial');
  const result = await sendViaConnector(account.email, { from: account.email.from, to, subject: 'Organization email test', text: 'This is a test of your organization email account in Typeroll.' });
  if (!result.ok) throw new OrganizationEmailError('The test email could not be confirmed', 502);
  return { ok: true, id: result.id };
}
