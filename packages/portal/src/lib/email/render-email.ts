// Renders an email from an EmailActionConfig + a submission's stored values.
//
// Templating mirrors the block renderer's conventions over a flat data object
// (submission field name → value): `{{field}}` is HTML-escaped, `{{{field}}}`
// is raw. We deliberately do NOT reuse the block renderer's private
// substituteFields — email has its own needs (plain-text mode, an "all values"
// dump, recipient validation) and a flat namespace.

import type { Block, EmailActionConfig, EmailConnector, Form } from '@typeroll/shared';
import { collectStepFields, escapeHtml } from '@typeroll/shared';
import type { EmailMessage } from './types';

const RAW_TOKEN = /\{\{\{\s*([\w.-]+)\s*\}\}\}/g;
const ESC_TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

function toScalar(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => toScalar(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Substitute `{{field}}` / `{{{field}}}` tokens.
 * - htmlEscape=true  → `{{x}}` is escaped, `{{{x}}}` is raw (for HTML bodies).
 * - htmlEscape=false → both forms emit the raw value (for plain-text / subjects).
 */
export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  htmlEscape: boolean,
): string {
  let out = template.replace(RAW_TOKEN, (_m, name: string) => toScalar(data[name]));
  out = out.replace(ESC_TOKEN, (_m, name: string) =>
    htmlEscape ? escapeHtml(toScalar(data[name])) : toScalar(data[name]),
  );
  return out;
}

/** A subject is single-line plain text: substitute raw, then strip newlines. */
function renderSubject(template: string, data: Record<string, unknown>): string {
  return renderTemplate(template, data, false).replace(/[\r\n]+/g, ' ').trim();
}

/** What the "all values" listing needs to know about one form field. */
export interface EmailField {
  name: string;
  /** Row header; the field name is used when empty. */
  label?: string;
  /** Hidden inputs (utm_* and the like) are left out when empty. */
  hidden?: boolean;
  /** Stored choice value → the label the visitor saw. */
  choices?: Map<string, string>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Consent text is rich text; a row header needs it as plain text. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The form's fields in the order they appear (steps in list order, nested
 * containers included), with labels and choice labels for the email listing.
 * A name used in several steps keeps its first definition.
 */
export function emailFieldsFromForm(form: Pick<Form, 'steps'>): EmailField[] {
  const choices = new Map<string, Map<string, string>>();
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      const d = (b.data ?? {}) as Record<string, unknown>;
      const name = typeof d.name === 'string' ? d.name.trim() : '';
      if (b.type.startsWith('form/') && name && Array.isArray(d.choices) && !choices.has(name)) {
        const map = new Map<string, string>();
        for (const c of d.choices as Array<{ value?: unknown; label?: unknown } | null>) {
          if (!c || typeof c !== 'object') continue;
          const value = String(c.value ?? c.label ?? '');
          if (!map.has(value)) map.set(value, String(c.label ?? c.value ?? ''));
        }
        choices.set(name, map);
      }
      if (b.children) walk(b.children);
      for (const slot of b.slots ?? []) walk(slot);
    }
  };
  const out: EmailField[] = [];
  const seen = new Set<string>();
  for (const step of form.steps ?? []) {
    walk(step.blocks ?? []);
    for (const f of collectStepFields(step.blocks)) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      const label = f.type === 'gdpr_consent' ? plainText(f.label) : f.label.trim();
      out.push({
        name: f.name,
        label: label || undefined,
        hidden: f.type === 'hidden' || undefined,
        choices: choices.get(f.name),
      });
    }
  }
  return out;
}

function choiceLabel(v: unknown, choices: Map<string, string> | undefined): unknown {
  if (!choices) return v;
  if (Array.isArray(v)) return v.map((x) => choiceLabel(x, choices));
  if (typeof v !== 'string' && typeof v !== 'number') return v;
  return choices.get(String(v)) || v;
}

/**
 * The rows of the "all values" listing. Without a form definition every
 * submitted key is listed as-is, in submission order. With one, rows follow
 * the form's field order under each field's label, choice values show their
 * label, empty hidden fields are dropped, and submitted keys the form does
 * not declare come last in submission order.
 */
function valueRows(data: Record<string, unknown>, fields?: EmailField[]): Array<[string, string]> {
  if (!fields) return Object.entries(data).map(([k, v]) => [k, toScalar(v)]);
  const rows: Array<[string, string]> = [];
  const known = new Set<string>();
  for (const f of fields) {
    known.add(f.name);
    if (!Object.hasOwn(data, f.name)) continue;
    const value = toScalar(choiceLabel(data[f.name], f.choices));
    if (f.hidden && value.trim() === '') continue;
    rows.push([f.label || f.name, value]);
  }
  for (const [k, v] of Object.entries(data)) if (!known.has(k)) rows.push([k, toScalar(v)]);
  return rows;
}

/**
 * An escaped HTML table / plain-text list of every submitted value. Pass the
 * form's fields (emailFieldsFromForm) to show labels instead of field names.
 */
export function renderAllValues(
  data: Record<string, unknown>,
  format: 'html' | 'text',
  fields?: EmailField[],
): string {
  const entries = valueRows(data, fields);
  if (format === 'text') {
    return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
  }
  const rows = entries
    .map(
      ([k, v]) =>
        `<tr><th align="left" style="padding:4px 12px 4px 0;vertical-align:top">${escapeHtml(
          k,
        )}</th><td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  return `<table style="border-collapse:collapse;font-family:system-ui,sans-serif">${rows}</table>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Templated, comma-split, validated recipient list. null when none valid. */
export function resolveRecipients(
  template: string,
  data: Record<string, unknown>,
): string | null {
  const rendered = renderTemplate(template, data, false);
  const valid = rendered
    .split(',')
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
  return valid.length ? valid.join(', ') : null;
}

export interface BuildResult {
  message?: EmailMessage;
  error?: string;
}

/**
 * Build an EmailMessage from an email action + submission data. Returns
 * `{ error }` (caller logs + skips) when the recipient can't be resolved.
 * `fields` (from emailFieldsFromForm) labels the include_all listing; without
 * it the listing shows raw field names.
 */
export function buildEmailMessage(
  action: EmailActionConfig,
  data: Record<string, unknown>,
  connector: EmailConnector,
  fields?: EmailField[],
): BuildResult {
  const to = resolveRecipients(action.to, data);
  if (!to) return { error: `email action: no valid recipient from "${action.to}"` };

  const format = action.format === 'text' ? 'text' : 'html';
  const subject = renderSubject(action.subject ?? '', data);
  let body = renderTemplate(action.body ?? '', data, format === 'html');
  if (action.include_all) {
    const all = renderAllValues(data, format, fields);
    body = format === 'html' ? `${body}\n<hr>\n${all}` : `${body}\n\n${all}`;
  }

  const cc = action.cc ? resolveRecipients(action.cc, data) ?? undefined : undefined;
  const bcc = action.bcc ? resolveRecipients(action.bcc, data) ?? undefined : undefined;
  const replyTo = action.reply_to ? renderTemplate(action.reply_to, data, false).trim() : undefined;

  const message: EmailMessage = {
    from: connector.from,
    to,
    cc,
    bcc,
    replyTo: replyTo || undefined,
    subject,
    ...(format === 'html' ? { html: body } : { text: body }),
  };
  return { message };
}
