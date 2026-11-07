// Pure helpers behind the package import on the Packages page: the request
// bodies for inspect and import, how the signature and the plan read, what
// blocks an import, the entries a user can choose and the report's links.
// PackageImport.tsx stays thin around these.

import {
  PACKAGE_LIMITS, SITE_PACKAGE_EXTENSION,
  type PackageDesignMode, type PackageSignatureStatus, type PlannedAction, type SitePackageKind,
} from '@typeroll/shared';
import { formatBytes } from './font-library-model';

export { formatBytes };

export type PackageCountKey = 'block_templates' | 'page_templates' | 'global_blocks' | 'block_types' | 'styles' | 'menus' | 'pages' | 'media' | 'fonts';

export interface InspectedPackage {
  id: string;
  name: string;
  version: string;
  kind: SitePackageKind;
  description?: string;
  author?: { name: string; url?: string };
  licence?: { name: string; url?: string };
  languages?: string[];
  created_at: string;
  counts: Partial<Record<PackageCountKey, number>>;
}

interface PlanEntry { action: PlannedAction; from: string; to: string }
interface NamedPlanEntry extends PlanEntry { name: string }

/** The import plan as the inspect route returns it (JSON: no id maps). */
export interface InspectPlan {
  styles: NamedPlanEntry[];
  block_types: PlanEntry[];
  block_templates: NamedPlanEntry[];
  page_templates: NamedPlanEntry[];
  global_blocks: Array<NamedPlanEntry & { kind: 'header' | 'footer' | 'free' }>;
  menus: Array<NamedPlanEntry & { locations?: string[] }>;
  site_field_groups: Array<{ action: PlannedAction; id: string }>;
  pages: PlanEntry[];
  design: Record<string, unknown> | null;
  fonts: Array<{ family: string; weight: number | [number, number]; style: 'normal' | 'italic' }>;
  media: string[];
}

export interface InspectResult {
  package: InspectedPackage;
  signature: { status: PackageSignatureStatus; publisher?: string };
  plan: InspectPlan;
  warnings: string[];
  needs: { admin: boolean; font_licence: boolean };
}

export interface ImportReport {
  created?: Record<string, unknown>;
  reused?: Record<string, unknown>;
  /** By kind, or a list of `{ section, from, to }` as the import route returns it. */
  renamed?: Record<string, unknown> | Array<{ section: string; from: string; to: string }>;
  warnings?: string[];
}

/**
 * The report with `renamed` keyed by kind, and renamed entries left out of
 * `created` (the route lists a renamed entry under both).
 */
export function normaliseReport(report: ImportReport): ImportReport & { renamed: Record<string, unknown> } {
  if (!Array.isArray(report.renamed)) return { ...report, renamed: report.renamed ?? {} };
  const renamed: Record<string, Array<{ from: string; to: string }>> = {};
  for (const entry of report.renamed) (renamed[entry.section] ??= []).push({ from: entry.from, to: entry.to });
  const created = Object.fromEntries(Object.entries(report.created ?? {}).map(([section, value]) => {
    const moved = new Set((renamed[section] ?? []).map(entry => entry.to));
    return [section, Array.isArray(value) ? value.filter(item => !(typeof item === 'string' && moved.has(item))) : value];
  }));
  return { ...report, created, renamed };
}

export interface PackageImportOptions {
  design: PackageDesignMode;
  fonts?: boolean;
  only?: string[];
  font_licence_confirmed?: boolean;
}

// ── The file ──────────────────────────────────────────────────────────────

export const ACCEPTED_PACKAGE_FILES = `${SITE_PACKAGE_EXTENSION},application/zip,application/vnd.typeroll.package+zip`;

/** Why a chosen file can't be a package, or null. */
export function packageFileProblem(file: Pick<File, 'name' | 'size'> | null): string | null {
  if (!file) return 'Choose a .typeroll file.';
  if (!file.name.toLowerCase().endsWith(SITE_PACKAGE_EXTENSION)) return `Choose a Typeroll package: a file ending in ${SITE_PACKAGE_EXTENSION}.`;
  if (file.size === 0) return 'The file is empty.';
  if (file.size > PACKAGE_LIMITS.zip_bytes) return `The file is ${formatBytes(file.size)}; a package can be at most ${formatBytes(PACKAGE_LIMITS.zip_bytes)}.`;
  return null;
}

/** Inspect and import both take the file and the options as a JSON string. */
export function packageFormData(file: Blob & { name?: string }, options: PackageImportOptions): FormData {
  const data = new FormData();
  data.set('file', file, file.name ?? 'package.typeroll');
  data.set('options', JSON.stringify(options));
  return data;
}

// ── Design modes ──────────────────────────────────────────────────────────

export const DESIGN_MODES: ReadonlyArray<{ value: PackageDesignMode; label: string; help: string; adminOnly?: boolean }> = [
  { value: 'content', label: 'Content only', help: 'The blocks, and the styles they use. Nothing else on the site changes.' },
  { value: 'styles', label: 'Content and styles', help: 'Also the package’s other styles, so they can be chosen on any block.' },
  { value: 'full', label: 'Whole look', help: 'Also the element styles (body text, headings, links), colours, typography and font roles. This changes how the whole site looks.', adminOnly: true },
];

export const WHOLE_LOOK_ADMIN_NOTE = 'Only a site admin can import the whole look, because it changes the site’s colours, typography and fonts.';

/** The options sent to inspect and import. Fonts travel only with the whole look. */
export function importOptions(state: { design: PackageDesignMode; includeFonts: boolean; only?: string[]; fontLicenceConfirmed?: boolean }): PackageImportOptions {
  const options: PackageImportOptions = { design: state.design };
  if (state.design === 'full') options.fonts = state.includeFonts;
  if (state.only) options.only = state.only;
  if (state.fontLicenceConfirmed) options.font_licence_confirmed = true;
  return options;
}

// ── Signature ─────────────────────────────────────────────────────────────

export interface SignatureNotice { tone: 'ok' | 'warn' | 'danger'; label: string; text: string; blocks: boolean }

/** How the signature reads, and whether it stops the import. */
export function signatureNotice(signature: InspectResult['signature'], author?: InspectedPackage['author']): SignatureNotice {
  const claimed = author?.name ? `It says it comes from ${author.name}, but that is not verified.` : 'It does not say who made it.';
  switch (signature.status) {
    case 'verified':
      return { tone: 'ok', label: 'Verified', text: `Signed by ${signature.publisher ?? 'a trusted publisher'}, a trusted publisher. The file is unchanged since it was signed.`, blocks: false };
    case 'unknown_key':
      return { tone: 'warn', label: 'Unknown key', text: `Signed with a key this Typeroll does not know. ${claimed} Import it only if you trust where you got it.`, blocks: false };
    case 'invalid':
      return { tone: 'danger', label: 'Invalid signature', text: 'The signature does not match the file: it was changed after it was signed, or the signature is broken. It can’t be imported.', blocks: true };
    default:
      return { tone: 'warn', label: 'Unsigned', text: `Nobody signed this package. ${claimed} Import it only if you trust where you got it.`, blocks: false };
  }
}

/** The publisher line: the verified publisher, else the author the file names. */
export function publisherLine(result: Pick<InspectResult, 'signature' | 'package'>): string {
  if (result.signature.status === 'verified' && result.signature.publisher) return result.signature.publisher;
  return result.package.author?.name ? `${result.package.author.name} (not verified)` : 'Not stated';
}

// ── Summary ───────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<SitePackageKind, string> = { collection: 'Templates and parts', site: 'Whole site', clipboard: 'Copied blocks' };

const COUNT_LABELS: Array<[PackageCountKey, string, string]> = [
  ['block_templates', 'block template', 'block templates'],
  ['page_templates', 'page template', 'page templates'],
  ['global_blocks', 'global block', 'global blocks'],
  ['block_types', 'block type', 'block types'],
  ['styles', 'style', 'styles'],
  ['menus', 'menu', 'menus'],
  ['pages', 'page', 'pages'],
  ['media', 'media file', 'media files'],
  ['fonts', 'font file', 'font files'],
];

/** "3 block templates", "1 style"… for the counts above zero. */
export function countLines(counts: InspectedPackage['counts']): string[] {
  return COUNT_LABELS.flatMap(([key, one, many]) => {
    const n = counts[key] ?? 0;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  });
}

// ── The plan ──────────────────────────────────────────────────────────────

export type PlanSection = 'styles' | 'block_types' | 'block_templates' | 'page_templates' | 'global_blocks' | 'menus' | 'site_field_groups' | 'pages';

export const PLAN_SECTION_LABELS: Record<PlanSection, string> = {
  block_templates: 'Block templates',
  page_templates: 'Page templates',
  global_blocks: 'Global blocks',
  pages: 'Pages',
  menus: 'Menus',
  site_field_groups: 'Site fields',
  block_types: 'Block types',
  styles: 'Styles',
};

const PLAN_ORDER: PlanSection[] = ['block_templates', 'page_templates', 'global_blocks', 'pages', 'menus', 'site_field_groups', 'block_types', 'styles'];

export interface PlanRow { key: string; name: string; id: string; action: PlannedAction; actionLabel: string; detail?: string }
export interface PlanGroup { section: PlanSection; label: string; rows: PlanRow[] }

const GLOBAL_KIND: Record<string, string> = { header: 'Header', footer: 'Footer', free: 'Shared block' };

/** What happens to one entry: "Create", "Reuse existing", "Rename → hero-2", "Replace", "Skip". */
export function actionLabel(action: PlannedAction, to: string): string {
  switch (action) {
    case 'create': return 'Create';
    case 'reuse': return 'Reuse existing';
    case 'rename': return `Rename → ${to}`;
    case 'replace': return 'Replace';
    default: return 'Skip';
  }
}

function actionDetail(section: PlanSection, action: PlannedAction): string | undefined {
  const thing = section === 'styles' ? 'style' : section === 'block_types' ? 'block type' : 'entry';
  if (action === 'reuse') return section === 'site_field_groups' ? 'The site already has the same settings page.' : `The site already has an identical ${thing}.`;
  if (action === 'rename') return section === 'styles'
    ? 'The site has a different style with this id; the import adds this one beside it, and the imported blocks use it.'
    : `The site already uses this id for another ${thing}; this one gets a new id.`;
  if (action === 'replace') return 'Replaces the site’s own style for this element.';
  if (action === 'skip') return 'The site already has a different version; the site’s own stays.';
  return undefined;
}

/** The plan grouped by kind, in reading order, without empty groups. */
export function planGroups(plan: InspectPlan): PlanGroup[] {
  return PLAN_ORDER.flatMap(section => {
    const rows: PlanRow[] = section === 'site_field_groups'
      ? (plan.site_field_groups ?? []).map(entry => ({ key: `${section}.${entry.id}`, name: entry.id, id: entry.id, action: entry.action, actionLabel: actionLabel(entry.action, entry.id), detail: actionDetail(section, entry.action) }))
      : ((plan[section] ?? []) as Array<PlanEntry & { name?: string; kind?: string }>).map(entry => ({
        key: `${section}.${entry.from}`,
        name: section === 'global_blocks' && entry.kind && entry.kind !== 'free' ? `${entry.name ?? entry.from} (${GLOBAL_KIND[entry.kind]})` : entry.name ?? entry.from,
        id: entry.action === 'rename' ? entry.from : entry.to,
        action: entry.action,
        actionLabel: actionLabel(entry.action, entry.to),
        detail: actionDetail(section, entry.action),
      }));
    return rows.length ? [{ section, label: PLAN_SECTION_LABELS[section], rows }] : [];
  });
}

/** "100 Regular", "100–900 italic" for the plan's font list. */
export function fontLine(font: InspectPlan['fonts'][number]): string {
  const weight = Array.isArray(font.weight) ? `${font.weight[0]}–${font.weight[1]}` : String(font.weight);
  return `${font.family} ${weight}${font.style === 'italic' ? ' italic' : ''}`;
}

/** The design settings a whole-look import replaces, as names. */
export function designLines(design: InspectPlan['design']): string[] {
  if (!design) return [];
  const names: Record<string, string> = { colors: 'Colours', typography: 'Typography', design_scales: 'Spacing and size scales', content_widths: 'Content widths', fonts: 'Font roles' };
  return Object.keys(design).filter(key => design[key] !== undefined && design[key] !== null && names[key]).map(key => names[key]);
}

// ── Choosing entries ──────────────────────────────────────────────────────

/** The `only` prefix of each choosable section (site fields are chosen as `site_fields.<id>`). */
const ONLY_PREFIX: Partial<Record<PlanSection, string>> = {
  block_templates: 'block_templates', page_templates: 'page_templates', global_blocks: 'global_blocks', pages: 'pages', menus: 'menus', site_field_groups: 'site_fields',
};

export interface ChoosableEntry { key: string; section: PlanSection; name: string }

/**
 * The entries a user can leave out, from a plan made without `only`. Styles
 * and block types follow the chosen content, so they are not chosen directly.
 */
export function choosableEntries(plan: InspectPlan): ChoosableEntry[] {
  return planGroups(plan).flatMap(group => {
    const prefix = ONLY_PREFIX[group.section];
    if (!prefix) return [];
    return group.rows.map(row => ({ key: `${prefix}.${row.key.slice(group.section.length + 1)}`, section: group.section, name: row.name }));
  });
}

/** `only` for the chosen keys: absent when everything is chosen. */
export function onlyFromSelection(entries: readonly ChoosableEntry[], chosen: ReadonlySet<string>): string[] | undefined {
  if (!entries.length || entries.every(entry => chosen.has(entry.key))) return undefined;
  return entries.filter(entry => chosen.has(entry.key)).map(entry => entry.key);
}

// ── What stops the import ─────────────────────────────────────────────────

/** Reasons the Import button is disabled; empty when it can run. */
export function importBlockers(input: { result: InspectResult; isAdmin: boolean; fontLicenceConfirmed: boolean; only?: string[] }): string[] {
  const reasons: string[] = [];
  if (signatureNotice(input.result.signature).blocks) reasons.push('The signature is invalid, so the package can’t be imported.');
  if (input.result.needs.admin && !input.isAdmin) reasons.push('This import changes the site’s look; only a site admin can import it.');
  if (input.result.needs.font_licence && !input.fontLicenceConfirmed) reasons.push('Confirm the font licence first.');
  if (input.only && input.only.length === 0) reasons.push('Choose at least one entry.');
  return reasons;
}

// ── Errors ────────────────────────────────────────────────────────────────

export interface PackageApiError { message: string; details: string[] }

const detailText = (detail: unknown): string => {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : JSON.stringify(detail);
    return typeof record.path === 'string' && record.path ? `${record.path}: ${message}` : message;
  }
  return String(detail);
};

/** The error message and its details (validation errors) from a 4xx/5xx body. */
export function packageApiError(body: unknown, status: number, action: string): PackageApiError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const message = typeof record.error === 'string' && record.error ? record.error : status === 413 ? 'The file is too large.' : `${action} failed (${status}).`;
  const raw = record.details;
  const details = Array.isArray(raw) ? raw.map(detailText) : raw && typeof raw === 'object' ? Object.entries(raw).map(([key, value]) => `${key}: ${detailText(value)}`) : typeof raw === 'string' ? [raw] : [];
  return { message, details };
}

// ── The report ────────────────────────────────────────────────────────────

const REPORT_LABELS: Record<string, string> = {
  ...PLAN_SECTION_LABELS, site_fields: 'Site fields', media: 'Media files', fonts: 'Font files', design: 'Design settings',
};

const REPORT_ORDER = ['block_templates', 'page_templates', 'global_blocks', 'pages', 'menus', 'site_field_groups', 'site_fields', 'block_types', 'styles', 'media', 'fonts', 'design'];

/** Where each kind of imported entry is managed. */
export function sectionHref(siteId: string, section: string): string | undefined {
  const base = `/app/sites/${encodeURIComponent(siteId)}`;
  switch (section) {
    case 'block_templates': return `${base}/partials#block-templates`;
    case 'global_blocks': return `${base}/partials`;
    case 'page_templates': return `${base}/templates`;
    case 'pages': return `${base}/pages`;
    case 'menus': return `${base}/menus`;
    case 'site_field_groups': case 'site_fields': return `${base}/site-fields`;
    case 'block_types': return `${base}/blocks`;
    case 'styles': case 'design': return `${base}/styles`;
    case 'media': return `${base}/media`;
    case 'fonts': return `${base}/fonts`;
    default: return undefined;
  }
}

/** The page of one imported entry, where it has its own. */
export function entryHref(siteId: string, section: string, id: string): string | undefined {
  const base = `/app/sites/${encodeURIComponent(siteId)}`;
  const safe = encodeURIComponent(id);
  switch (section) {
    case 'global_blocks': return `${base}/partials/${safe}`;
    case 'page_templates': return `${base}/templates/${safe}`;
    case 'pages': return `${base}/pages/${safe}`;
    case 'menus': return `${base}/menus/${safe}`;
    default: return sectionHref(siteId, section);
  }
}

export interface ReportItem { label: string; href?: string }
export interface ReportSection { section: string; label: string; href?: string; created: ReportItem[]; reused: number; renamed: ReportItem[]; count: number }

/** Entries of one report value: a count, a list of ids or `{ from, to, name }`, or an id map. */
function reportEntries(value: unknown): { count: number; ids: Array<{ id: string; label: string; from?: string }> } {
  if (typeof value === 'number') return { count: value, ids: [] };
  if (typeof value === 'boolean') return { count: value ? 1 : 0, ids: [] };
  if (Array.isArray(value)) {
    const ids = value.flatMap(item => {
      if (typeof item === 'string') return [{ id: item, label: item }];
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const id = typeof record.to === 'string' ? record.to : typeof record.id === 'string' ? record.id : null;
        if (!id) return [];
        const name = typeof record.name === 'string' ? record.name : id;
        return [{ id, label: name, from: typeof record.from === 'string' ? record.from : undefined }];
      }
      return [];
    });
    return { count: value.length, ids };
  }
  if (value && typeof value === 'object') {
    const ids = Object.entries(value).map(([from, to]) => ({ id: typeof to === 'string' ? to : from, label: typeof to === 'string' ? to : from, from }));
    return { count: ids.length, ids };
  }
  return { count: 0, ids: [] };
}

/** The import report by kind, with links to where each entry is managed. */
export function reportSections(input: ImportReport, siteId: string): ReportSection[] {
  const report = normaliseReport(input);
  const keys = new Set([...Object.keys(report.created ?? {}), ...Object.keys(report.reused ?? {}), ...Object.keys(report.renamed ?? {})]);
  const ordered = [...REPORT_ORDER.filter(key => keys.has(key)), ...[...keys].filter(key => !REPORT_ORDER.includes(key)).sort()];
  return ordered.flatMap(section => {
    const created = reportEntries(report.created?.[section]);
    const reused = reportEntries(report.reused?.[section]);
    const renamed = reportEntries(report.renamed?.[section]);
    const count = created.count + reused.count + renamed.count;
    if (!count) return [];
    const link = (entry: { id: string; label: string }) => ({ label: entry.label, href: entryHref(siteId, section, entry.id) });
    return [{
      section,
      label: REPORT_LABELS[section] ?? section.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase()),
      href: sectionHref(siteId, section),
      created: created.ids.map(link),
      reused: reused.count,
      renamed: renamed.ids.map(entry => ({ ...link(entry), label: entry.from && entry.from !== entry.id ? `${entry.label} (was ${entry.from})` : entry.label })),
      count,
    }];
  });
}

/** "2 created, 1 reused, 1 renamed". */
export function reportCounts(section: ReportSection, input: ImportReport): string {
  const report = normaliseReport(input);
  const parts: string[] = [];
  const created = reportEntries(report.created?.[section.section]).count;
  const renamed = reportEntries(report.renamed?.[section.section]).count;
  if (created) parts.push(`${created} created`);
  if (section.reused) parts.push(`${section.reused} reused`);
  if (renamed) parts.push(`${renamed} renamed`);
  return parts.join(', ');
}
