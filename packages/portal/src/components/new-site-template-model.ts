// The "Start from a template or another site" form on the new-site page:
// the requests it sends and what it shows about the chosen source. The
// component is NewSiteFromTemplate.tsx; the API is /api/sites/create and
// /api/sites/create/preview.

import type { PackageDesignMode } from '@typeroll/shared';
import { packageApiError, packageFileProblem, signatureNotice, type PackageApiError, type SignatureNotice } from './package-import-model';

export type StartKind = 'site' | 'collection_entry' | 'package';

export interface SourceSite { id: string; name: string }
export interface SourcePackage { id: string; name: string; publisher?: string; verified?: boolean; languages?: string[]; pages?: number; description?: string }

/** What the form has chosen. */
export interface StartChoice { kind: StartKind; siteId?: string; entryId?: string; file?: File | null }

export interface StartPreview {
  source: { name: string; version?: string; package_id?: string; site_id?: string; collection_entry?: string };
  counts: { pages: number; global_blocks: number; menus: number; media: number; demo_media: number; fonts: number };
  package: null | {
    id: string; name: string; version: string; kind: string; description?: string;
    author?: { name: string; url?: string }; licence?: { name: string; url?: string }; languages?: string[];
  };
  signature: { status: 'verified' | 'unsigned' | 'unknown_key' | 'invalid'; publisher?: string };
  language: string | null;
  needs: { font_licence: boolean; fonts: string[] };
  warnings: string[];
  errors: string[];
}

export interface CreatedSite {
  id: string;
  url: string;
  started_from?: { warnings: string[]; defaults: string[]; report?: { created?: { media?: string[]; pages?: string[] } } };
}

export const START_KINDS: ReadonlyArray<{ value: StartKind; label: string; help: string }> = [
  { value: 'site', label: 'Another site of this organization', help: 'A copy of its pages, header and footer, menus, styles, site fields and media.' },
  { value: 'collection_entry', label: 'A site package from the collection', help: 'A whole site saved in your organization’s collection.' },
  { value: 'package', label: 'A .typeroll file', help: 'A whole-site package, for example a template you bought.' },
];

export const NEW_SITE_DESIGN_MODES: ReadonlyArray<{ value: PackageDesignMode; label: string; help: string }> = [
  { value: 'full', label: 'The whole look', help: 'Colours, typography, fonts and every style, as the template has them.' },
  { value: 'styles', label: 'Its styles only', help: 'The template’s styles with the default colours and typography.' },
  { value: 'content', label: 'Content only', help: 'The pages and the styles they use, in the default look.' },
];

/** Import options for a new site: fonts only with the licence confirmed, otherwise left out. */
export function startOptions(state: { design: PackageDesignMode; needsFontLicence: boolean; fontLicenceConfirmed: boolean }): Record<string, unknown> {
  if (state.design !== 'full' || !state.needsFontLicence) return { design: state.design };
  return state.fontLicenceConfirmed ? { design: 'full', font_licence_confirmed: true } : { design: 'full', fonts: false };
}

/** The JSON `from` of a site or collection source; null for a file or nothing chosen. */
export function jsonFrom(choice: StartChoice): Record<string, string> | null {
  if (choice.kind === 'site' && choice.siteId) return { site_id: choice.siteId };
  if (choice.kind === 'collection_entry' && choice.entryId) return { collection_entry: choice.entryId };
  return null;
}

/** Whether a choice names a source the form can preview. */
export function choiceReady(choice: StartChoice): boolean {
  return choice.kind === 'package' ? !!choice.file && !packageFileProblem(choice.file) : !!jsonFrom(choice);
}

/** The preview request for a choice. */
export function previewRequest(choice: StartChoice, options: Record<string, unknown>): { url: string; init: RequestInit } {
  const url = '/api/sites/create/preview';
  if (choice.kind === 'package') {
    const body = new FormData();
    body.append('package', choice.file!, choice.file!.name || 'site.typeroll');
    body.append('options', JSON.stringify(options));
    return { url, init: { method: 'POST', body } };
  }
  return { url, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: jsonFrom(choice), options }) } };
}

/** The create request for a choice. */
export function createRequest(choice: StartChoice, name: string, options: Record<string, unknown>): { url: string; init: RequestInit } {
  const url = '/api/sites/create';
  if (choice.kind === 'package') {
    const body = new FormData();
    body.append('name', name.trim());
    body.append('package', choice.file!, choice.file!.name || 'site.typeroll');
    body.append('options', JSON.stringify(options));
    return { url, init: { method: 'POST', headers: { Accept: 'application/json' }, body } };
  }
  return { url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: name.trim(), from: jsonFrom(choice), options }) } };
}

/** The signature line for a package; a site copy needs none. */
export function startSignature(preview: StartPreview): SignatureNotice | null {
  if (!preview.package) return null;
  return signatureNotice(preview.signature, preview.package.author);
}

/** The publisher line: the verified publisher, else the author the package names. */
export function startPublisher(preview: StartPreview): string {
  if (preview.signature.status === 'verified' && preview.signature.publisher) return preview.signature.publisher;
  return preview.package?.author?.name ? `${preview.package.author.name} (not verified)` : 'Not stated';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the new site would contain, in a line. */
export function startContents(preview: StartPreview): string {
  const c = preview.counts;
  const parts = [plural(c.pages, 'page'), plural(c.global_blocks, 'global block'), plural(c.menus, 'menu'), plural(c.media, 'media file')];
  if (c.fonts) parts.push(plural(c.fonts, 'font family', 'font families'));
  return parts.join(', ');
}

/** Why the form cannot create the site yet. */
export function createBlockers(state: { name: string; choice: StartChoice; preview: StartPreview | null }): string[] {
  const out: string[] = [];
  if (!state.name.trim()) out.push('Give the new site a name.');
  if (state.choice.kind === 'package' && state.choice.file) {
    const problem = packageFileProblem(state.choice.file);
    if (problem) out.push(problem);
  }
  if (!choiceReady(state.choice)) out.push(state.choice.kind === 'site' ? 'Choose the site to start from.' : state.choice.kind === 'collection_entry' ? 'Choose a site package from the collection.' : 'Choose a .typeroll file.');
  else if (!state.preview) out.push('Checking the source…');
  if (state.preview) out.push(...state.preview.errors);
  return out;
}

/** Notes to show after creating: the import's warnings and the demo images to replace. */
export function createdNotes(created: CreatedSite, preview: StartPreview | null): string[] {
  const notes = [...(created.started_from?.warnings ?? [])];
  const demo = preview?.counts.demo_media ?? 0;
  if (demo) notes.push(`${plural(demo, 'demo image')} from the template ${demo === 1 ? 'is' : 'are'} marked for replacement; the site’s readiness lists ${demo === 1 ? 'it' : 'them'}.`);
  return notes;
}

export { packageApiError, type PackageApiError };
