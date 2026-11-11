// Default markup for app contract mounts, collected while a publication is
// frozen (both runners, after build derivations).
//
// Every contract mount of the site (component, variant, page language) is
// collected from the projected publication, each app is called once per
// declared `default_markup` path with all of its mounts, and the answer is
// frozen as `extension_markup` (shared/extension-markup.ts writes it into the
// built pages). The frozen value doubles as the fallback store: when an app
// does not answer, or answers something invalid, the previous publication's
// markup, files and styles for that app are reused, else its mounts stay
// empty. A publication never fails on default markup; each fallback becomes
// a non-blocking warning on the job.

import { createHash } from 'node:crypto';
import {
  EXTENSION_MARKUP_FORMAT,
  extensionContractVariant,
  extensionMarkupKey,
  isExtensionAssetPath,
  paths,
  type ExtensionInstallation,
  type ExtensionRuntimeSnapshot,
  type ExtensionVersion,
  type FrozenExtensionAsset,
  type FrozenExtensionMarkup,
  type FrozenExtensionMarkupApp,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { callContractApp } from './contract-calls';

export const MAX_MARKUP_BYTES = 256 * 1024;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_APP_ASSET_BYTES = 10 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ASSET_TYPES = new Set(['text/javascript', 'application/javascript', 'text/css', 'application/json', 'image/svg+xml', 'image/png', 'image/webp', 'font/woff2']);

interface Mount { key: string; component_id: string; variant: string; language: string }

const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const language = (value: unknown, fallback: string) => typeof value === 'string' && LANGUAGE.test(value) ? value : fallback;

/** Every contract mount in the frozen content, keyed by installation. Global content (partials, templates) mounts in every site language. */
export function collectContractMounts(
  frozen: Record<string, any>,
  snapshot: Pick<ExtensionRuntimeSnapshot, 'installations'>,
): { mounts: Map<string, Map<string, Mount>>; defaultLanguage: string } {
  const byBlockType = new Map<string, { installation: string; component: string }>();
  for (const installation of snapshot.installations ?? []) {
    for (const component of installation.components ?? []) {
      if (component.render_mode === 'contract_component') byBlockType.set(component.block_type_id, { installation: installation.installation_id, component: component.id });
    }
  }
  const defaultLanguage = language(frozen.settings?.language, 'en');
  const languages = new Set([defaultLanguage, ...(frozen.pages ?? []).map((page: any) => language(page?.language, defaultLanguage)),
    ...(frozen.settings?.language_sections ?? []).map((section: any) => language(section?.language, defaultLanguage))]);
  const mounts = new Map<string, Map<string, Mount>>();
  const add = (blockTypeId: string, rawVariant: unknown, inLanguages: Iterable<string>) => {
    const found = byBlockType.get(blockTypeId);
    if (!found) return;
    const variant = extensionContractVariant(rawVariant);
    const forApp = mounts.get(found.installation) ?? new Map<string, Mount>();
    mounts.set(found.installation, forApp);
    for (const lang of inLanguages) {
      const key = extensionMarkupKey(found.component, variant, lang);
      forApp.set(key, { key, component_id: found.component, variant, language: lang });
    }
  };
  const directive = /<x-extension\b([^>]*)>/gi;
  const walk = (value: unknown, inLanguages: Iterable<string>, depth = 0): void => {
    if (depth > 64 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (!value.includes('<x-extension')) return;
      for (const match of value.matchAll(directive)) {
        const attrs = match[1]!;
        const block = /\bblock\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        const variant = /\bvariant\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        if (block) add((block[1] ?? block[2] ?? '').trim(), variant ? variant[1] ?? variant[2] : undefined, inLanguages);
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, inLanguages, depth + 1); return; }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string' && byBlockType.has(record.type)) {
      add(record.type, (record.data as Record<string, unknown> | undefined)?.variant, inLanguages);
    }
    for (const child of Object.values(record)) walk(child, inLanguages, depth + 1);
  };
  for (const page of frozen.pages ?? []) walk(page, [language(page?.language, defaultLanguage)]);
  for (const field of ['partials', 'pageTemplates', 'blockTypes', 'contentTypes']) walk(frozen[field], languages);
  return { mounts, defaultLanguage };
}

/** Validate an app's answer for one call; throws on anything Core cannot freeze. */
export function frozenAppMarkup(extensionId: string, requested: Mount[], data: Record<string, unknown>): FrozenExtensionMarkupApp {
  if (!data.markup || typeof data.markup !== 'object' || Array.isArray(data.markup)) throw new Error('The app returned no markup object');
  if (data.assets !== undefined && (!Array.isArray(data.assets) || data.assets.length > 100)) throw new Error('assets must be an array of at most 100 files');
  const segment = extensionId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'app';
  const byName = new Map<string, FrozenExtensionAsset & { sha256: string }>();
  let total = 0;
  for (const raw of (data.assets ?? []) as unknown[]) {
    const asset = raw as { name?: unknown; content_type?: unknown; body_base64?: unknown };
    if (typeof asset?.name !== 'string' || !ASSET_NAME.test(asset.name) || asset.name.includes('..')) throw new Error('An asset name must be a simple file name');
    if (typeof asset.content_type !== 'string' || !ASSET_TYPES.has(asset.content_type)) throw new Error(`Asset ${asset.name} has an unsupported content type`);
    if (typeof asset.body_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.body_base64)) throw new Error(`Asset ${asset.name} is not base64`);
    const bytes = Buffer.from(asset.body_base64, 'base64');
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`Asset ${asset.name} exceeds ${MAX_ASSET_BYTES / 1024 / 1024} MiB`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = byName.get(asset.name);
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error(`Asset ${asset.name} is returned twice with different content`);
      continue;
    }
    total += bytes.byteLength;
    if (total > MAX_APP_ASSET_BYTES) throw new Error(`Assets exceed ${MAX_APP_ASSET_BYTES / 1024 / 1024} MiB per build`);
    byName.set(asset.name, { path: `/_assets/apps/${segment}/${sha256.slice(0, 16)}/${asset.name}`, content_type: asset.content_type, body_base64: bytes.toString('base64'), sha256 });
  }
  const rewrite = (html: string) => html.replace(/\{\{asset:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}\}/g, (whole, name: string) => byName.get(name)?.path ?? whole);
  const keys = new Set(requested.map((mount) => mount.key));
  const markup: Record<string, string> = {};
  for (const [key, html] of Object.entries(data.markup as Record<string, unknown>)) {
    if (!keys.has(key)) continue;
    if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_MARKUP_BYTES) throw new Error(`Markup for ${key} must be a string of at most ${MAX_MARKUP_BYTES / 1024} KiB`);
    markup[key] = rewrite(html);
  }
  if (data.styles !== undefined && (!Array.isArray(data.styles) || data.styles.length > 20)) throw new Error('styles must be an array of at most 20 asset names');
  const styles = ((data.styles ?? []) as unknown[]).map((name) => {
    const asset = typeof name === 'string' ? byName.get(name) : undefined;
    if (!asset || asset.content_type !== 'text/css') throw new Error(`Style ${String(name)} must name a returned text/css asset`);
    return asset.path;
  });
  return { extension_id: extensionId, markup, assets: [...byName.values()].map(({ sha256: _sha, ...asset }) => asset), styles: [...new Set(styles)] };
}

function mergeApp(target: FrozenExtensionMarkupApp, source: FrozenExtensionMarkupApp): void {
  Object.assign(target.markup, source.markup);
  for (const asset of source.assets) if (!target.assets.some((existing) => existing.path === asset.path)) target.assets.push(asset);
  for (const style of source.styles) if (!target.styles.includes(style)) target.styles.push(style);
}

/** The previous publication's frozen entry for an app, limited to the mounts asked for now. */
function previousApp(prior: FrozenExtensionMarkup | undefined, installationId: string, requested: Mount[]): FrozenExtensionMarkupApp | null {
  const app = prior?.format === EXTENSION_MARKUP_FORMAT ? prior.apps?.[installationId] : undefined;
  if (!app) return null;
  const markup = Object.fromEntries(requested.filter((mount) => typeof app.markup?.[mount.key] === 'string').map((mount) => [mount.key, app.markup[mount.key]!]));
  return { extension_id: app.extension_id, markup, assets: (app.assets ?? []).filter((asset) => isExtensionAssetPath(asset.path)), styles: (app.styles ?? []).filter(isExtensionAssetPath) };
}

export type ContractMarkupRequest = (
  installation: ExtensionInstallation, release: ExtensionVersion, path: string, body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const defaultRequest: ContractMarkupRequest = (installation, release, path, body) => callContractApp(installation, release, 'default_markup', path, body,
  { requestBytes: 1024 * 1024, responseBytes: 16 * 1024 * 1024 });

/**
 * Ask every contract app for its mounts' default markup. Returns undefined
 * markup when the site has no contract mount, so other publications do not
 * change shape.
 */
export async function prepareExtensionMarkup(args: {
  orgId: string;
  siteId: string;
  frozen: Record<string, any>;
  snapshot: Pick<ExtensionRuntimeSnapshot, 'installations'>;
  prior?: { extension_markup?: FrozenExtensionMarkup } | null;
  request?: ContractMarkupRequest;
}): Promise<{ markup?: FrozenExtensionMarkup; warnings: string[] }> {
  const { mounts, defaultLanguage } = collectContractMounts(args.frozen, args.snapshot);
  if (!mounts.size) return { warnings: [] };
  const request = args.request ?? defaultRequest;
  const store = getStore();
  const warnings: string[] = [];
  const apps: FrozenExtensionMarkup['apps'] = {};
  for (const [installationId, appMounts] of mounts) {
    const runtime = args.snapshot.installations.find((item) => item.installation_id === installationId)!;
    const fail = (requested: Mount[], reason: string) => {
      const previous = previousApp(args.prior?.extension_markup, installationId, requested);
      const reused = previous ? Object.keys(previous.markup).length : 0;
      if (previous) mergeApp(apps[installationId] ??= { extension_id: runtime.extension_id, markup: {}, assets: [], styles: [] }, previous);
      warnings.push(`extension_default_markup_unavailable: ${runtime.extension_id} (${installationId}): ${reason.replace(/[\r\n]+/g, ' ').slice(0, 300)}. ` +
        (reused ? `Reused the previous publication's markup for ${reused} of ${requested.length} mounts.` : `Its ${requested.length} ${requested.length === 1 ? 'mount stays' : 'mounts stay'} empty until the app answers.`));
    };
    const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(args.orgId, args.siteId, installationId));
    // The exact frozen release, never a newer one registered mid-build.
    const release = installation && await store.getDoc<ExtensionVersion>(paths.extensionVersion(installation.developer_org_id, installation.extension_id, runtime.version));
    if (!installation || !release) { fail([...appMounts.values()], 'the installation or its frozen release is unavailable'); continue; }
    // One call per declared path; normally every component of an app shares it.
    const byPath = new Map<string, Mount[]>();
    for (const mount of appMounts.values()) {
      const path = release.manifest.frontend?.components.find((component) => component.id === mount.component_id)?.default_markup?.path;
      if (path) byPath.set(path, [...byPath.get(path) ?? [], mount]);
    }
    for (const [path, requested] of byPath) {
      try {
        const data = await request(installation, release, path, { mounts: requested.map(({ key, component_id, variant, language }) => ({ key, component_id, variant, language })) });
        mergeApp(apps[installationId] ??= { extension_id: runtime.extension_id, markup: {}, assets: [], styles: [] }, frozenAppMarkup(runtime.extension_id, requested, data));
      } catch (error) {
        fail(requested, error instanceof Error ? error.message : 'the app did not answer');
      }
    }
  }
  return { markup: { format: EXTENSION_MARKUP_FORMAT, default_language: defaultLanguage, apps }, warnings };
}
