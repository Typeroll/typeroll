import { digest } from './providers.mjs';

export interface ImpactEntry {
  kind: string; id: string; title: string; content_type?: string;
  fields: Record<string, string>; metadata: string; date_updated: string;
}
/**
 * Versions the platform puts into a publication, recorded in plain text so a
 * comparison can say what changed. They are not the site's own content: a
 * Typeroll release changes them on every site at once.
 */
export interface ImpactPlatform {
  extension_runtime_version: string | null;
  extension_protocol_version: number | null;
  /** The runtime versions reach the built pages only when the site has installations. */
  extension_installations: number;
}
export interface ImpactSnapshot {
  protocol: 2; org_id: string; site_id: string; version_id: string;
  core_commit: string; entries: ImpactEntry[];
  /** From Core 0.3.28. Snapshots without it fingerprinted the extension runtime versions inside configuration/extensions. */
  platform?: ImpactPlatform;
}
/** What a comparison needs to read a baseline captured before `platform` existed (see legacyBaseline). */
export interface LegacyBaseline { platform: ImpactPlatform; extensions: string }
export interface PlatformChange { id: 'core_commit' | 'extension_runtime'; name: string; before: string | null; after: string | null; affects_output: boolean }
/**
 * Why there was nothing to compare with:
 * - not_published: this version has no recorded publication yet;
 * - publication_not_verified: its last publication did not succeed, was a dry run or belongs to another version;
 * - snapshot_without_source_baseline: its snapshot records no source fingerprint in the current format (a
 *   publication from before Core 0.2.0, or a domain change built from one);
 * - baseline_snapshot_unreadable: the snapshot a domain change was built from can no longer be read;
 * - baseline_identity_mismatch: the recorded fingerprint belongs to another organization, site or version.
 */
export type BaselineUnavailableReason = 'not_published' | 'publication_not_verified' | 'snapshot_without_source_baseline' | 'baseline_snapshot_unreadable' | 'baseline_identity_mismatch';
export const BASELINE_UNAVAILABLE_MESSAGE = 'No verified publication of this version records its saved source, so nothing was compared: changes are unknown, not none, and total 0 with an empty changes list means "not compared". The next publication builds and publishes every saved public page as usual. Publish once to record a baseline for later comparisons; until then a dry run (trigger_deploy with dry_run: true) validates the full build without publishing.';

export interface PublicationImpact {
  comparison: 'verified_snapshot' | 'baseline_unavailable';
  /** False when there was no baseline: the counts and changes below are then empty because nothing was compared. */
  changes_known: boolean;
  baseline: { state: 'verified' } | { state: 'unavailable'; reason: BaselineUnavailableReason | null; message: string };
  provisional: boolean; execution: 'automatic'; reuse_verified: false;
  classification: 'none' | 'page_content_only' | 'site_wide' | 'unknown';
  changed_pages: number; added_pages: number; removed_pages: number;
  metadata_only: number; total: number;
  changes: Array<{ kind: string; id: string; title: string; content_type?: string; action: 'added' | 'changed' | 'removed'; fields: string[]; date_updated: string; will_deploy: true }>;
  /** What the platform changed since the baseline (a Typeroll release), never counted in total or changes. */
  platform_changes: PlatformChange[];
  reasons: string[];
}

/** Object key ordering is not a content change; array ordering can affect output. */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
}
const fingerprint = (value: any) => digest(JSON.stringify(canonical(value)));
const entryKey = (entry: { kind: string; id: string; content_type?: string }) => JSON.stringify([entry.kind, entry.id]);

function impactEntry(kind: string, value: any, content_type?: string): ImpactEntry {
  const { date_updated, updated_at, ...content } = value;
  return { kind, id: value.id, title: [value.title, value.name, value.id].find(label => typeof label === 'string' && label.length > 0) ?? String(value.id),
    ...(content_type ? { content_type } : {}), date_updated: date_updated ?? updated_at ?? '',
    metadata: fingerprint({ date_updated, updated_at }),
    fields: Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined).map(([key, value]) => [key, fingerprint(value)])),
  };
}
const ORIGINS = { id: 'impact_origins', name: 'Publication addresses' } as const;
const EXTENSIONS = { id: 'extensions', name: 'Extensions' } as const;

function platformOf(extensions: any): ImpactPlatform {
  return { extension_runtime_version: typeof extensions?.runtime_version === 'string' ? extensions.runtime_version : null,
    extension_protocol_version: typeof extensions?.protocol_version === 'number' ? extensions.protocol_version : null,
    extension_installations: Array.isArray(extensions?.installations) ? extensions.installations.length : 0 };
}
/** The site's own Extension configuration: its installations, without the runtime versions a release sets. */
const siteExtensions = (extensions: any) => ({ installations: extensions?.installations ?? [] });

/**
 * A baseline captured before Core 0.3.28 hashed `extensions` whole, runtime
 * versions included, so every release that raised them (0.3.27: runtime 0.45.0
 * to 0.46.0) showed configuration/extensions as changed on every site, also on
 * sites without a single installation. The baseline's own frozen publication
 * still holds those versions in plain text: hash the current installations the
 * old way with the baseline's versions, and an equal hash means the site's
 * installations did not change.
 */
export function legacyBaseline(baselinePublication: any, currentPublication: any): LegacyBaseline {
  const before = baselinePublication?.extensions ?? null;
  const current = currentPublication?.extensions ?? { installations: [] };
  const oldShape = before ? { ...current, runtime_version: before.runtime_version, protocol_version: before.protocol_version } : current;
  return { platform: platformOf(before), extensions: impactEntry('configuration', { ...EXTENSIONS, value: oldShape }).fields.value };
}

/** Fingerprint only the public projection. Working copies and private fields never enter this snapshot. */
export function captureImpact(publication: any, orgId: string, siteId: string, media: any[] = []): ImpactSnapshot {
  const entries: ImpactEntry[] = [];
  const add = (kind: string, value: any, content_type?: string) => { entries.push(impactEntry(kind, value, content_type)); };
  for (const [kind, values] of Object.entries({ page: publication.pages, partial: publication.partials, menu: publication.menus, template: publication.pageTemplates, block_type: publication.blockTypes, redirect: publication.redirects, form: publication.forms, content_type: publication.contentTypes })) {
    for (const value of (values ?? []) as any[]) add(kind, value);
  }
  for (const [key, title] of Object.entries({ site: 'Site identity', settings: 'Site settings', apps: 'Apps', runtime_dependencies: 'Runtime connections', [ORIGINS.id]: ORIGINS.name })) add('configuration', { id: key, name: title, value: publication[key] ?? null });
  add('configuration', { ...EXTENSIONS, value: siteExtensions(publication.extensions) });
  // Only a publication with site fields lists them, so earlier snapshots compare unchanged.
  if (publication.siteFields) add('configuration', { id: 'siteFields', name: 'Site fields', value: publication.siteFields });
  const content = JSON.stringify(publication);
  for (const item of media) {
    const urls = [item.cdn_url, ...(item.source_aliases ?? []), ...(item.variants ?? []).map((variant: any) => variant.cdn_url)];
    if (!urls.some(url => typeof url === 'string' && url && content.includes(url))) continue;
    // No storage credentials, bucket paths or migration bookkeeping are exposed.
    add('media', { id: item.id, sha256: item.sha256 ?? null, size_bytes: item.size_bytes ?? null,
      mime_type: item.mime_type ?? null, width: item.width ?? null, height: item.height ?? null,
      filename: item.filename ?? null, title: item.title ?? null, alt_text: item.alt_text ?? null, caption: item.caption ?? null });
  }
  entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  if (new Set(entries.map(entryKey)).size !== entries.length) throw Error('Duplicate impact identity');
  return { protocol: 2, org_id: orgId, site_id: siteId, version_id: publication.version_id, core_commit: publication.core_commit, entries, platform: platformOf(publication.extensions) };
}

/**
 * The same source fingerprint, served at other addresses. A domain change
 * republishes the last publication's content unchanged with new origins, so its
 * baseline is that publication's fingerprint with only the addresses replaced.
 */
export function withImpactOrigins(snapshot: ImpactSnapshot, origins: unknown): ImpactSnapshot {
  const entry = impactEntry('configuration', { ...ORIGINS, value: origins ?? null });
  return { ...snapshot, entries: snapshot.entries.map(item => item.kind === 'configuration' && item.id === ORIGINS.id ? entry : item) };
}

/** Observe net source changes, never authorize reuse without an output dependency graph. */
export function compareImpact(previous: ImpactSnapshot | null | undefined, current: ImpactSnapshot, provisional = false, unavailable: BaselineUnavailableReason | null = null, legacy?: LegacyBaseline): PublicationImpact {
  const result: PublicationImpact = { comparison: 'baseline_unavailable', changes_known: false, baseline: { state: 'unavailable', reason: unavailable, message: BASELINE_UNAVAILABLE_MESSAGE },
    provisional, execution: 'automatic', reuse_verified: false,
    classification: 'unknown', changed_pages: 0, added_pages: 0, removed_pages: 0, metadata_only: 0, total: 0, changes: [], platform_changes: [], reasons: [] };
  if (!previous || previous.protocol !== 2 || ['org_id', 'site_id', 'version_id'].some(key => previous[key as keyof ImpactSnapshot] !== current[key as keyof ImpactSnapshot])) {
    if (previous && !unavailable) result.baseline = { state: 'unavailable', reason: previous.protocol !== 2 ? 'snapshot_without_source_baseline' : 'baseline_identity_mismatch', message: BASELINE_UNAVAILABLE_MESSAGE };
    result.reasons.push('verified_source_baseline_unavailable'); return result;
  }
  result.comparison = 'verified_snapshot'; result.changes_known = true; result.baseline = { state: 'verified' };
  const extensionsKey = entryKey({ kind: 'configuration', id: EXTENSIONS.id });
  let previousPlatform = previous.platform ?? legacy?.platform;
  let baselineEntries = previous.entries;
  if (!previous.platform && legacy) {
    // An older baseline: its extensions hash matches the current installations hashed the old way only when they are unchanged.
    const now = current.entries.find(entry => entryKey(entry) === extensionsKey);
    baselineEntries = previous.entries.map(entry => entryKey(entry) === extensionsKey && now && entry.fields.value === legacy.extensions ? { ...entry, fields: now.fields } : entry);
  } else if (!previous.platform) previousPlatform = undefined;
  const before = new Map(baselineEntries.map(entry => [entryKey(entry), entry]));
  const after = new Map(current.entries.map(entry => [entryKey(entry), entry]));
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key), b = after.get(key), entry = (b ?? a)!;
    const fields = [...new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})])].sort().filter(field => a?.fields[field] !== b?.fields[field]);
    if (a && b && !fields.length) { if (a.metadata !== b.metadata) result.metadata_only++; continue; }
    const action = !a ? 'added' : !b ? 'removed' : 'changed';
    result.changes.push({ kind: entry.kind, id: entry.id, title: entry.title, ...(entry.content_type ? { content_type: entry.content_type } : {}), action, fields, date_updated: entry.date_updated, will_deploy: true });
    if (entry.kind === 'page') result[`${action}_pages`]++;
  }
  result.total = result.changes.length;
  if (previous.core_commit !== current.core_commit) {
    result.reasons.push('toolchain_changed');
    result.platform_changes.push({ id: 'core_commit', name: 'Typeroll Core release', before: previous.core_commit || null, after: current.core_commit || null, affects_output: true });
  }
  const runtime = (platform: ImpactPlatform | undefined) => platform?.extension_runtime_version == null ? null : `${platform.extension_runtime_version} (protocol ${platform.extension_protocol_version ?? 'unknown'})`;
  if (previousPlatform && current.platform && runtime(previousPlatform) !== runtime(current.platform)) {
    // The runtime script and its versions reach the pages only on a site with installations.
    const affects = previousPlatform.extension_installations > 0 || current.platform.extension_installations > 0;
    result.platform_changes.push({ id: 'extension_runtime', name: 'Extension runtime', before: runtime(previousPlatform), after: runtime(current.platform), affects_output: affects });
    if (affects) result.reasons.push('extension_runtime_changed');
  }
  if (result.metadata_only) result.reasons.push('publication_metadata_changed');
  const pageOnly = result.total > 0 && result.changes.every(change => change.kind === 'page' && change.action === 'changed' && change.fields.every(field => ['html_content', 'blocks', 'custom_css'].includes(field)));
  result.classification = result.reasons.some(reason => ['toolchain_changed', 'extension_runtime_changed'].includes(reason)) ? 'site_wide' : !result.total ? 'none' : pageOnly ? 'page_content_only' : 'site_wide';
  result.reasons.push(result.total ? 'saved_public_source_changed' : 'no_public_content_changes', 'output_dependencies_not_verified');
  // Keep responses bounded, but compute every count before truncation.
  result.changes = result.changes.slice(0, 50);
  return result;
}
