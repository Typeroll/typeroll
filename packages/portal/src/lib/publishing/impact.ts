import { digest } from './providers.mjs';

export interface ImpactEntry {
  kind: string; id: string; title: string; collection?: string;
  fields: Record<string, string>; metadata: string; date_updated: string;
}
export interface ImpactSnapshot {
  protocol: 1; org_id: string; site_id: string; version_id: string;
  core_commit: string; entries: ImpactEntry[];
}
export interface PublicationImpact {
  comparison: 'verified_snapshot' | 'baseline_unavailable';
  provisional: boolean; execution: 'full'; reuse_verified: false;
  classification: 'none' | 'page_content_only' | 'site_wide' | 'unknown';
  changed_pages: number; added_pages: number; removed_pages: number;
  metadata_only: number; total: number;
  changes: Array<{ kind: string; id: string; title: string; collection?: string; action: 'added' | 'changed' | 'removed'; fields: string[]; date_updated: string; will_deploy: true }>;
  reasons: string[];
}

/** Object key ordering is not a content change; array ordering can affect output. */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
}
const fingerprint = (value: any) => digest(JSON.stringify(canonical(value)));
const entryKey = (entry: { kind: string; id: string; collection?: string }) => JSON.stringify([entry.kind, entry.collection ?? '', entry.id]);

/** Fingerprint only the public projection. Working copies and private fields never enter this snapshot. */
export function captureImpact(publication: any, orgId: string, siteId: string, media: any[] = []): ImpactSnapshot {
  const entries: ImpactEntry[] = [];
  const add = (kind: string, value: any, collection?: string) => {
    const { date_updated, updated_at, ...content } = value;
    entries.push({ kind, id: value.id, title: [value.title, value.name, value.id].find(label => typeof label === 'string' && label.length > 0) ?? String(value.id),
      ...(collection ? { collection } : {}), date_updated: date_updated ?? updated_at ?? '',
      metadata: fingerprint({ date_updated, updated_at }),
      fields: Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined).map(([key, value]) => [key, fingerprint(value)])),
    });
  };
  for (const [kind, values] of Object.entries({ page: publication.pages, partial: publication.partials, template: publication.pageTemplates, block_type: publication.blockTypes, redirect: publication.redirects, form: publication.forms })) {
    for (const value of (values ?? []) as any[]) add(kind, value);
  }
  for (const collection of publication.collections ?? []) {
    add('collection', collection.definition);
    for (const item of collection.items) add('collection_item', item, collection.definition.name);
  }
  for (const [key, title] of Object.entries({ site: 'Site identity', settings: 'Site settings', apps: 'Apps', extensions: 'Extensions', runtime_dependencies: 'Runtime connections', impact_origins: 'Publication addresses' })) add('configuration', { id: key, name: title, value: publication[key] ?? null });
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
  return { protocol: 1, org_id: orgId, site_id: siteId, version_id: publication.version_id, core_commit: publication.core_commit, entries };
}

/** Observe net source changes, never authorize reuse without an output dependency graph. */
export function compareImpact(previous: ImpactSnapshot | null | undefined, current: ImpactSnapshot, provisional = false): PublicationImpact {
  const result: PublicationImpact = { comparison: 'baseline_unavailable', provisional, execution: 'full', reuse_verified: false,
    classification: 'unknown', changed_pages: 0, added_pages: 0, removed_pages: 0, metadata_only: 0, total: 0, changes: [], reasons: [] };
  if (!previous || previous.protocol !== 1 || ['org_id', 'site_id', 'version_id'].some(key => previous[key as keyof ImpactSnapshot] !== current[key as keyof ImpactSnapshot])) {
    result.reasons.push('verified_source_baseline_unavailable'); return result;
  }
  result.comparison = 'verified_snapshot';
  const before = new Map(previous.entries.map(entry => [entryKey(entry), entry]));
  const after = new Map(current.entries.map(entry => [entryKey(entry), entry]));
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key), b = after.get(key), entry = (b ?? a)!;
    const fields = [...new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})])].sort().filter(field => a?.fields[field] !== b?.fields[field]);
    if (a && b && !fields.length) { if (a.metadata !== b.metadata) result.metadata_only++; continue; }
    const action = !a ? 'added' : !b ? 'removed' : 'changed';
    result.changes.push({ kind: entry.kind, id: entry.id, title: entry.title, ...(entry.collection ? { collection: entry.collection } : {}), action, fields, date_updated: entry.date_updated, will_deploy: true });
    if (entry.kind === 'page') result[`${action}_pages`]++;
  }
  result.total = result.changes.length;
  if (previous.core_commit !== current.core_commit) result.reasons.push('toolchain_changed');
  if (result.metadata_only) result.reasons.push('publication_metadata_changed');
  const pageOnly = result.total > 0 && result.changes.every(change => change.kind === 'page' && change.action === 'changed' && change.fields.every(field => ['html_content', 'blocks', 'custom_css'].includes(field)));
  result.classification = result.reasons.includes('toolchain_changed') ? 'site_wide' : !result.total ? 'none' : pageOnly ? 'page_content_only' : 'site_wide';
  result.reasons.push(result.total ? 'saved_public_source_changed' : 'no_public_content_changes', 'output_dependencies_not_verified');
  // Keep responses bounded, but compute every count before truncation.
  result.changes = result.changes.slice(0, 50);
  return result;
}
