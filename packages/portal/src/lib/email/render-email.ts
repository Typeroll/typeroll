// Renders an email from an EmailActionConfig + a submission's stored values.
//
// Templating mirrors the block renderer's conventions over a flat data object
// (submission field name → value): `{{field}}` is HTML-escaped, `{{{field}}}`
// is raw. We deliberately do NOT reuse the block renderer's private
// substituteFields — email has its own needs (plain-text mode, an "all values"
// dump, recipient validation) and a flat namespace.

import type { EmailActionConfig, EmailConnector } from '@typeroll/shared';
import { escapeHtml } from '@typeroll/shared';
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

/** An escaped HTML table / plain-text list of every submitted value. */
export function renderAllValues(data: Record<string, unknown>, format: 'html' | 'text'): string {
  const entries = Object.entries(data);
  if (format === 'text') {
    return entries.map(([k, v]) => `${k}: ${toScalar(v)}`).join('\n');
  }
  const rows = entries
    .map(
      ([k, v]) =>
        `<tr><th align="left" style="padding:4px 12px 4px 0;vertical-align:top">${escapeHtml(
          k,
        )}</th><td style="padding:4px 0">${escapeHtml(toScalar(v))}</td></tr>`,
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
 */
export function buildEmailMessage(
  action: EmailActionConfig,
  data: Record<string, unknown>,
  connector: EmailConnector,
): BuildResult {
  const to = resolveRecipients(action.to, data);
  if (!to) return { error: `email action: no valid recipient from "${action.to}"` };

  const format = action.format === 'text' ? 'text' : 'html';
  const subject = renderSubject(action.subject ?? '', data);
  let body = renderTemplate(action.body ?? '', data, format === 'html');
  if (action.include_all) {
    const all = renderAllValues(data, format);
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
