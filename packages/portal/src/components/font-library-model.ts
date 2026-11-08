// Pure helpers behind the Fonts library page: grouping, labels, the upload
// draft and its form data, and prefilling from an inspected file.

import {
  FAMILY_PATTERN, FONT_UPLOAD_FORMATS, MAX_FONT_UPLOAD_BYTES, SITE_FONT_ROLES, fontFileWeightRange,
  type SiteFontFile, type SiteFontRole,
} from '@typeroll/shared';
import { ROLE_LABEL } from './font-picker-model';

export interface FontFamilyGroup {
  family: string;
  files: SiteFontFile[];
  category?: 'sans' | 'serif';
  /** Roles that use the family (from `used_by`). */
  roles: SiteFontRole[];
}

const lower = (value: string) => value.trim().toLowerCase();

/** Library files grouped by family: upright before italic, light to bold. */
export function groupFontFamilies(files: readonly SiteFontFile[], usedBy: Record<string, readonly string[]> = {}): FontFamilyGroup[] {
  const groups = new Map<string, SiteFontFile[]>();
  for (const file of files) groups.set(lower(file.family), [...groups.get(lower(file.family)) ?? [], file]);
  const used = new Map(Object.entries(usedBy).map(([family, roles]) => [lower(family), roles]));
  return [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => (a.style === b.style ? 0 : a.style === 'italic' ? 1 : -1) || fontFileWeightRange(a)[0] - fontFileWeightRange(b)[0]);
    const roles = (used.get(lower(group[0]!.family)) ?? []).filter((role): role is SiteFontRole => (SITE_FONT_ROLES as readonly string[]).includes(role));
    // The family keeps the spelling of its first upload.
    return { family: group[0]!.family, files: sorted, category: sorted.find(file => file.category)?.category, roles };
  }).sort((a, b) => a.family.localeCompare(b.family));
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

/** "400 Regular", "700 Bold italic", "100–900 variable". */
export function formatFontWeight(file: Pick<SiteFontFile, 'weight' | 'style'>): string {
  const italic = file.style === 'italic';
  if (Array.isArray(file.weight)) return `${file.weight[0]}–${file.weight[1]} variable${italic ? ' italic' : ''}`;
  const name = WEIGHT_NAMES[file.weight];
  return `${file.weight}${name ? ` ${name}` : ''}${italic ? (name ? ' italic' : ' Italic') : ''}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "WOFF2" or "WOFF2, converted from TTF". */
export function fontFormatLabel(file: Pick<SiteFontFile, 'original'>): string {
  return file.original ? `WOFF2, converted from ${file.original.format.toUpperCase()}` : 'WOFF2';
}

export const rolesLabel = (roles: readonly SiteFontRole[]) => roles.map(role => ROLE_LABEL[role]).join(', ');

/** A weight field: "400" or a variable range "100-900" (en dash too), in steps of 100 as the upload route takes them. */
export function parseFontWeight(input: string): number | [number, number] | null {
  const value = input.trim().replace(/\s+/g, '');
  const valid = (n: number) => Number.isInteger(n) && n >= 100 && n <= 900 && n % 100 === 0;
  const range = /^(\d{1,4})[-–](\d{1,4})$/.exec(value);
  if (range) {
    const min = Number(range[1]), max = Number(range[2]);
    return valid(min) && valid(max) && min < max ? [min, max] : null;
  }
  if (/^\d{1,4}$/.test(value)) return valid(Number(value)) ? Number(value) : null;
  return null;
}

export const weightInput = (weight: SiteFontFile['weight']) => Array.isArray(weight) ? `${weight[0]}-${weight[1]}` : String(weight);

export const ACCEPTED_FONT_FILES = FONT_UPLOAD_FORMATS.map(format => `.${format}`).join(',');

export function fontFileExtension(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
}

export interface UploadDraft {
  file: File | null;
  family: string;
  weight: string;
  style: 'normal' | 'italic';
  category: '' | 'sans' | 'serif';
  licence_confirmed: boolean;
  licence_note: string;
}

export const emptyUploadDraft = (): UploadDraft => ({ file: null, family: '', weight: '400', style: 'normal', category: '', licence_confirmed: false, licence_note: '' });

/** Problems that block an upload, keyed by field. */
export function uploadProblems(draft: UploadDraft): Partial<Record<'file' | 'family' | 'weight' | 'licence', string>> {
  const problems: Partial<Record<'file' | 'family' | 'weight' | 'licence', string>> = {};
  if (!draft.file) problems.file = 'Choose a font file.';
  else if (!(FONT_UPLOAD_FORMATS as readonly string[]).includes(fontFileExtension(draft.file.name))) problems.file = 'Use a WOFF2, WOFF, TTF or OTF file.';
  else if (draft.file.size > MAX_FONT_UPLOAD_BYTES) problems.file = `The file is ${formatBytes(draft.file.size)}; the limit is ${formatBytes(MAX_FONT_UPLOAD_BYTES)}.`;
  if (draft.family.trim() && !FAMILY_PATTERN.test(draft.family.trim())) problems.family = 'Use letters, digits and spaces (at most 80 characters).';
  if (!parseFontWeight(draft.weight)) problems.weight = 'Enter a weight from 100 to 900 in steps of 100, such as 400, or a range such as 100-900 for a variable font.';
  if (!draft.licence_confirmed) problems.licence = 'Confirm that the font’s licence allows using it on this website.';
  return problems;
}

/** The multipart body for POST /api/sites/{siteId}/fonts. */
export function uploadFormData(draft: UploadDraft): FormData {
  const data = new FormData();
  if (draft.file) data.set('file', draft.file);
  if (draft.family.trim()) data.set('family', draft.family.trim());
  const weight = parseFontWeight(draft.weight);
  if (weight) data.set('weight', Array.isArray(weight) ? `${weight[0]}-${weight[1]}` : String(weight));
  data.set('style', draft.style);
  if (draft.category) data.set('category', draft.category);
  data.set('licence_confirmed', draft.licence_confirmed ? 'true' : 'false');
  if (draft.licence_note.trim()) data.set('licence_note', draft.licence_note.trim());
  return data;
}

/** What POST /fonts/inspect reads from a file. */
export interface InspectedFont {
  format?: string;
  outlines?: string;
  family?: string;
  subfamily?: string;
  weight?: number;
  italic?: boolean;
  variable?: { axes?: string[]; wght?: [number, number] };
}

/** Prefill the draft's family, weight and style from an inspected file. */
export function prefillFromInspect(draft: UploadDraft, info: InspectedFont): UploadDraft {
  // The route takes weights in steps of 100: round a variable axis inwards and a static weight to the nearest.
  const range = info.variable?.wght ? [Math.ceil(info.variable.wght[0] / 100) * 100, Math.floor(info.variable.wght[1] / 100) * 100] : null;
  const weight = range && range[0] < range[1] ? `${range[0]}-${range[1]}`
    : info.weight ? String(Math.min(900, Math.max(100, Math.round(info.weight / 100) * 100))) : draft.weight;
  return { ...draft, family: info.family?.trim() || draft.family, weight, style: info.italic ? 'italic' : 'normal' };
}

/** A sentence describing an inspected file, e.g. "Variable font, weights 100–900 (axes wght, opsz)". */
export function describeInspected(info: InspectedFont): string {
  const parts: string[] = [];
  if (info.family) parts.push(`${info.family}${info.subfamily ? ` ${info.subfamily}` : ''}`);
  if (info.variable) parts.push(`variable font${info.variable.wght ? `, weights ${info.variable.wght[0]}–${info.variable.wght[1]}` : ''}${info.variable.axes?.length ? ` (axes ${info.variable.axes.join(', ')})` : ''}`);
  else if (info.weight) parts.push(`weight ${info.weight}${info.italic ? ' italic' : ''}`);
  if (info.format) parts.push(`${info.format.toUpperCase()}${info.format.toLowerCase() === 'woff2' ? '' : ', converted to WOFF2 when saved'}`);
  return parts.join(' · ');
}

/** The message for a failed font request. */
export function fontApiError(body: { error?: string; code?: string } | null | undefined, status: number, action: string): string {
  return body?.error ? body.error : `${action} failed (${status}).`;
}

/** The PATCH body for an edited file: only changed fields. */
export function fontPatch(file: SiteFontFile, edit: { family: string; weight: string; style: 'normal' | 'italic'; category: '' | 'sans' | 'serif'; licence_note: string }): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (edit.family.trim() && edit.family.trim() !== file.family) patch.family = edit.family.trim();
  const weight = parseFontWeight(edit.weight);
  if (weight && weightInput(weight) !== weightInput(file.weight)) patch.weight = weight;
  if (edit.style !== file.style) patch.style = edit.style;
  if (edit.category && edit.category !== file.category) patch.category = edit.category;
  if (edit.licence_note.trim() !== (file.licence.note ?? '')) patch.licence_note = edit.licence_note.trim();
  return Object.keys(patch).length ? patch : null;
}
