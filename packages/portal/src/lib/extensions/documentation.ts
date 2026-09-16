import { randomUUID } from 'node:crypto';
import { paths, type Extension, type ExtensionInstallation, type ExtensionVersion } from '@typeroll/shared';
import { getStore } from '../datastore';
import { signInstallationAssertion } from './auth';
import { fetchPublicAsset, parsePublicHttpsUrl } from './public-http';

/** A bounded document read, never a general-purpose provider API proxy. */
export async function readInstallationGuide(installation: ExtensionInstallation, version: ExtensionVersion): Promise<{ status: string; markdown?: string }> {
  if (installation.status !== 'enabled') return { status: 'unavailable' };
  const documentation = version.manifest.documentation;
  if (!documentation || documentation.access !== 'installation') return { status: 'not_provided' };
  try {
    const extension = await getStore().getDoc<Extension>(paths.extension(installation.developer_org_id, version.extension_id));
    const url = parsePublicHttpsUrl(documentation.url, 'Documentation URL');
    if (!extension || extension.status !== 'active' || !extension.trusted_origins.includes(url.origin)) return { status: 'unavailable' };
    const token = signInstallationAssertion({ installation, scopes: [], correlationId: randomUUID(), purpose: 'documentation', version: version.version });
    const bytes = await fetchPublicAsset(url.href, 256 * 1024, fetch, { Authorization: `Bearer ${token}`, Accept: 'text/markdown' });
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!markdown.trim()) return { status: 'unavailable' };
    return { status: 'available', markdown };
  } catch {
    return { status: 'unavailable' };
  }
}
