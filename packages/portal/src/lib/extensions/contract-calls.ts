// Server-side calls Core makes to an app contract: the variants of a
// component (editor picker and MCP) and, once per publication, the default
// markup of every mount (contract-markup.ts). Modelled on form providers:
// a purpose-bound, body-bound installation assertion, a relative path below
// the release's `api.base_url` (the contract's stable address) and the
// approved-admin transport, which pins the address and bounds the response.

import { createHash, randomUUID } from 'node:crypto';
import {
  EXTENSION_DEFAULT_VARIANT,
  EXTENSION_VARIANT_PATTERN,
  paths,
  type ExtensionFrontendComponent,
  type ExtensionInstallation,
  type ExtensionVersion,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { adminDestination, requestApprovedAdmin } from './admin-request';
import { extensionIssuer, signInstallationAssertion } from './auth';
import { resolveExtensionVersion } from './resolution';

export class ContractCallError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'contract_app_unavailable') {
    super(message);
    this.name = 'ContractCallError';
  }
}

export async function callContractApp(
  installation: ExtensionInstallation,
  release: ExtensionVersion,
  purpose: 'component_variants' | 'default_markup',
  path: string,
  body: Record<string, unknown>,
  limits = { requestBytes: 262144, responseBytes: 262144 },
): Promise<Record<string, unknown>> {
  const base = release.manifest.api?.base_url;
  if (!base) throw new ContractCallError('The app declares no API');
  const request = { page_id: purpose, method: 'POST' as const, path, body };
  const url = adminDestination(base, request);
  const token = signInstallationAssertion({
    installation, scopes: [], correlationId: randomUUID(), purpose, version: release.version,
    bodySha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
  const response = await requestApprovedAdmin(url, request, token, extensionIssuer(), limits);
  if (response.status < 200 || response.status >= 300) throw new ContractCallError(`The app answered HTTP ${response.status}`);
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new ContractCallError('The app returned no JSON object');
  return response.data as Record<string, unknown>;
}

export interface ExtensionVariant { id: string; label: string }

export const STANDARD_VARIANTS: ExtensionVariant[] = [{ id: EXTENSION_DEFAULT_VARIANT, label: 'Standard' }];

/** Variants of an installed contract component; the single `standard` when the app declares none. */
export async function listExtensionVariants(
  orgId: string,
  siteId: string,
  installationId: string,
  componentId: string,
): Promise<{ variants: ExtensionVariant[]; source: 'app' | 'standard' }> {
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(orgId, siteId, installationId));
  if (!installation || installation.status !== 'enabled') throw new ContractCallError('Installation not found', 404, 'not_found');
  const release = (await resolveExtensionVersion(installation)).version;
  const component: ExtensionFrontendComponent | undefined = release?.manifest.frontend?.components.find((entry) => entry.id === componentId);
  if (!release || !component) throw new ContractCallError('Component not found', 404, 'not_found');
  if (component.render_mode !== 'contract_component') throw new ContractCallError('Only app contract components have variants', 409, 'not_a_contract_component');
  if (!component.variants) return { variants: STANDARD_VARIANTS, source: 'standard' };
  const data = await callContractApp(installation, release, 'component_variants', component.variants.path, { component_id: component.id });
  if (!Array.isArray(data.variants) || data.variants.length > 500) throw new ContractCallError('The app returned invalid variants');
  const variants = data.variants.map((raw) => {
    const item = raw as { id?: unknown; label?: unknown };
    if (typeof item?.id !== 'string' || !EXTENSION_VARIANT_PATTERN.test(item.id) || (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 200)))
      throw new ContractCallError('The app returned an invalid variant');
    return { id: item.id, label: typeof item.label === 'string' && item.label.trim() ? item.label : item.id };
  });
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) throw new ContractCallError('The app returned duplicate variant ids');
  return { variants, source: 'app' };
}
