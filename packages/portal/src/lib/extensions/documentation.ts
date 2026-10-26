import { randomUUID } from 'node:crypto';
import { paths, type Extension, type ExtensionInstallation, type ExtensionVersion } from '@typeroll/shared';
import { getStore } from '../datastore';
import { createSafeFetch } from '../net/safe-fetch';
import { signInstallationAssertion } from './auth';
import { fetchPublicAsset, parsePublicHttpsUrl } from './public-http';

const MAX_GUIDE_BYTES = 256 * 1024;
// Pinned to the validated address; fetchPublicAsset refuses redirects and enforces the limit.
export const installationGuideFetch = createSafeFetch({ label: 'Documentation URL', maxRedirects: 0, timeoutMs: 10_000, maxBytes: MAX_GUIDE_BYTES });

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
    const bytes = await fetchPublicAsset(url.href, MAX_GUIDE_BYTES, installationGuideFetch, { Authorization: `Bearer ${token}`, Accept: 'text/markdown' });
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!markdown.trim()) return { status: 'unavailable' };
    return { status: 'available', markdown };
  } catch {
    return { status: 'unavailable' };
  }
}
