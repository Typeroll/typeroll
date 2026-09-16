import { paths, type ExtensionInstallation, type Form } from '@typeroll/shared';
import { getStore } from '../datastore';
import { formEmbedInfo } from '../forms-signing';
import { extensionIssuer } from '../extensions/auth';
import { resolveExtensionVersion } from '../extensions/resolution';

export interface FormEndpoint { submit_url: string; submit_token: null; pow_bits: 0 }

/** Resolve only declared, installed provider routes. Never turn a missing app form into a normal submission. */
export async function resolveAppFormEndpoint(
  form: Pick<Form, 'target'>,
  args: { orgId: string; siteId: string; portalUrl: string },
): Promise<FormEndpoint | null> {
  if (!form.target) return null;
  const id = form.target.installation_id;
  if (!id) {
    if (form.target.app) throw new Error('This form requires migration to its owning app installation before publishing');
    return null;
  }
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(args.orgId, args.siteId, id));
  if (!installation || installation.status !== 'enabled') throw new Error('The form app installation is unavailable');
  const version = (await resolveExtensionVersion(installation)).version;
  const api = version?.manifest.api;
  const route = form.target.path;
  if (!api || !route || !api.routes.some(item => item.path === route && item.methods.includes('POST'))) throw new Error('The form endpoint is not declared by its app');
  if (!route.startsWith('/') || route.startsWith('//') || /[?#]/.test(route)) throw new Error('Invalid app form route');
  const url = new URL(api.base_url.replace(/\/$/, '') + route);
  url.searchParams.set('issuer', args.portalUrl);
  url.searchParams.set('org_id', args.orgId);
  url.searchParams.set('site_id', args.siteId);
  url.searchParams.set('installation_id', id);
  return { submit_url: url.href, submit_token: null, pow_bits: 0 };
}

export function validInstallationFormTarget(target: unknown): target is NonNullable<Form['target']> {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const value = target as Record<string, unknown>;
  return typeof value.installation_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.installation_id) &&
    typeof value.path === 'string' && !value.path.startsWith('//') && /^\/[A-Za-z0-9/_-]+$/.test(value.path) &&
    Object.keys(value).every(key => ['installation_id','path','hydrate','session_param'].includes(key)) &&
    (value.hydrate === undefined || typeof value.hydrate === 'boolean') &&
    (value.session_param === undefined || (typeof value.session_param === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.session_param)));
}

export async function installedFormEmbedInfo(orgId: string, siteId: string, form: Form) {
  if (!form.target) return formEmbedInfo(orgId, siteId, form.id);
  try {
    const endpoint = await resolveAppFormEndpoint(form, { orgId, siteId, portalUrl: extensionIssuer() });
    return endpoint ?? formEmbedInfo(orgId, siteId, form.id);
  } catch { return { submit_url: null, submit_token: null, pow_bits: 0, unavailable: 'The form app must be installed, enabled and configured before use.' }; }
}
