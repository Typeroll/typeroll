// Shared form validation + projection used by BOTH the API-key v1 routes and
// the cookie-auth admin routes, so the two auth surfaces can't drift on what a
// valid form looks like.
//
// Email `actions` carry recipient addresses and templates that read raw
// submission data, so only site admins write them: through the portal's Forms
// editor (cookie-auth admin route) or an admin API key / MCP
// (form-actions-api.ts). Both validate with validateEmailActions below. The
// portal chat assistant has no tool for them.

import crypto from 'node:crypto';
import type { Form, FormField, FormStep, FormAction, EmailActionConfig } from '@typeroll/shared';
import { encryptSecret, SECRET_MASK } from './secret-crypto';
import { parseWebhookUrl } from './forms/webhook';

export const FORM_ID_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const ALLOWED_FIELD_TYPES = new Set([
  'text', 'email', 'tel', 'url', 'number', 'textarea',
  'select', 'checkbox', 'radio', 'hidden', 'gdpr_consent',
]);

/** Validate + normalize a fields[] array. Returns the array or an error string. */
export function validateFields(fields: unknown): FormField[] | string {
  if (!Array.isArray(fields)) return 'fields must be an array';
  if (fields.length === 0) return 'fields[] cannot be empty';
  const names = new Set<string>();
  const out: FormField[] = [];
  for (const raw of fields) {
    const f = raw as Partial<FormField>;
    if (!f.name || typeof f.name !== 'string' || !FORM_ID_RE.test(f.name)) {
      return `Invalid field name "${f.name}" — must match [a-z][a-z0-9_-]*`;
    }
    if (names.has(f.name)) return `Duplicate field name "${f.name}"`;
    names.add(f.name);
    if (!f.label || typeof f.label !== 'string') return `Field "${f.name}" needs a label`;
    if (!f.type || !ALLOWED_FIELD_TYPES.has(String(f.type))) {
      return `Field "${f.name}" has invalid type. Allowed: ${[...ALLOWED_FIELD_TYPES].join(', ')}`;
    }
    if ((f.type === 'select' || f.type === 'radio') && (!Array.isArray(f.options) || f.options.length === 0)) {
      return `Field "${f.name}" (type ${f.type}) needs options[]`;
    }
    out.push({
      name: f.name,
      type: f.type,
      label: f.label,
      required: Boolean(f.required),
      placeholder: f.placeholder ? String(f.placeholder) : undefined,
      options: f.options as string[] | undefined,
      default: f.default,
    });
  }
  return out;
}

/** Forms 2.0 steps[]: non-empty array of { id, render?, … } with unique ids. */
export function validSteps(steps: unknown): steps is FormStep[] {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  const ids = new Set<string>();
  for (const st of steps) {
    if (!st || typeof st !== 'object') return false;
    const id = (st as { id?: unknown }).id;
    if (typeof id !== 'string' || !id || ids.has(id)) return false;
    ids.add(id);
    const render = (st as { render?: unknown }).render;
    if (render !== undefined && render !== 'static' && render !== 'dynamic') return false;
    const label = (st as { submit_label?: unknown }).submit_label;
    if (label !== undefined && (typeof label !== 'string' || label.length > MAX_STEP_LABEL)) return false;
  }
  return true;
}

export const MAX_STEP_LABEL = 80;
export const STEPS_ERROR = `steps must be a non-empty array of { id, blocks?, render?: static|dynamic, next?, submit_label? (at most ${MAX_STEP_LABEL} characters) } with unique ids`;

/** Form-level step navigation options, as every write surface accepts them. */
export interface FormNavigationInput {
  /** null clears it (back to the render version's default). */
  allow_back?: boolean | null;
  /** false or null turns it off. */
  show_progress?: Form['show_progress'] | null;
}

export function validateFormNavigation(body: Record<string, unknown>): FormNavigationInput | string {
  const out: FormNavigationInput = {};
  if (body.allow_back !== undefined) {
    if (body.allow_back !== null && typeof body.allow_back !== 'boolean') return 'allow_back must be true, false or null (default)';
    out.allow_back = body.allow_back;
  }
  if (body.show_progress !== undefined) {
    const value = body.show_progress;
    if (value !== null && typeof value !== 'boolean' && value !== 'text' && value !== 'bar') return 'show_progress must be true, "text", "bar" or false';
    out.show_progress = value === false ? null : value;
  }
  return out;
}

/** Merge navigation options into a stored form; null removes the key. */
export function applyFormNavigation<T extends Partial<Form>>(doc: T, input: FormNavigationInput): T {
  const next: Record<string, unknown> = { ...doc };
  for (const key of ['allow_back', 'show_progress'] as const) {
    if (!(key in input)) continue;
    if (input[key] === null) delete next[key];
    else next[key] = input[key];
  }
  return next as T;
}

/** Portal editor: set or clear (empty string) the button label of existing steps. */
export function applyStepLabels(steps: FormStep[], labels: unknown): FormStep[] | string {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return 'step_labels must be an object of step id → label';
  const entries = Object.entries(labels as Record<string, unknown>);
  for (const [id, label] of entries) {
    if (!steps.some((step) => step.id === id)) return `Unknown step "${id}"`;
    if (typeof label !== 'string' || label.length > MAX_STEP_LABEL) return `The button label of step "${id}" must be text of at most ${MAX_STEP_LABEL} characters`;
  }
  const byId = new Map(entries as Array<[string, string]>);
  return steps.map((step) => {
    if (!byId.has(step.id)) return step;
    const label = byId.get(step.id)!.trim();
    const { submit_label: _previous, ...rest } = step;
    return label ? { ...rest, submit_label: label } : rest;
  });
}

/** Project a stored field to its known schema so legacy/server keys don't leak. */

const NON_EMPTY_STR = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate + normalize an `actions[]` array, as written by the cookie-auth
 * admin route.
 *
 * `email` gets bespoke validation because its config is security-relevant
 * (a recipient address) and because good errors matter for the one type
 * everyone uses. Every OTHER registered type passes through with its config
 * intact — the registry owns what those mean, and rejecting them here would
 * make the form editor able to add actions that saving then deleted.
 *
 * `knownTypes` comes from the caller (the action registry); a type not in it
 * is refused, so a typo doesn't silently persist a no-op action.
 */
export function validateEmailActions(
  actions: unknown,
  knownTypes?: string[],
  existingActions: FormAction[] = [],
  allowedWebhookFields?: string[],
): FormAction[] | string {
  if (!Array.isArray(actions)) return 'actions must be an array';
  const out: FormAction[] = [];
  for (const raw of actions) {
    const a = raw as Partial<FormAction>;
    if (a?.type === 'webhook') {
      if (knownTypes && !knownTypes.includes(a.type)) return 'Unknown action type "webhook"';
      const c = (a.config ?? {}) as Record<string, unknown>;
      let url: URL;
      try { url = parseWebhookUrl(String(c.url ?? '').trim()); }
      catch (error) { return error instanceof Error ? error.message : 'Webhook URL is invalid'; }
      const fields = (Array.isArray(c.fields) ? c.fields : String(c.fields ?? '').split(','))
        .map((field) => String(field).trim()).filter(Boolean);
      if (fields.length === 0) return 'Webhook needs at least one allowed field';
      if (fields.some((field) => !FORM_ID_RE.test(field))) {
        return 'Webhook fields must be comma-separated field names matching [a-z][a-z0-9_-]*';
      }
      if (allowedWebhookFields && fields.some((field) => !allowedWebhookFields.includes(field))) {
        return 'Webhook fields must reference fields declared by this form';
      }
      const webhookId = NON_EMPTY_STR(a.id) ? a.id : crypto.randomUUID();
      const existing = existingActions.find((candidate) => candidate.type === 'webhook' && candidate.id === webhookId);
      const incomingSecret = c.secret;
      let secretEnc: string | undefined;
      if (NON_EMPTY_STR(incomingSecret) && incomingSecret !== SECRET_MASK) {
        try { secretEnc = encryptSecret(incomingSecret); }
        catch (error) { return error instanceof Error ? error.message : 'Webhook secret could not be encrypted'; }
      } else if (typeof existing?.config.secret_enc === 'string') {
        secretEnc = existing.config.secret_enc;
      }
      if (!secretEnc) return 'Webhook signing secret is required';
      out.push({
        id: webhookId,
        type: 'webhook',
        config: { url: url.href, fields: [...new Set(fields)], secret_enc: secretEnc, webhook_id: webhookId },
      });
      continue;
    }
    if (a?.type !== 'email') {
      if (!a?.type) return 'Each action needs a type';
      if (knownTypes && !knownTypes.includes(a.type)) {
        return `Unknown action type "${a.type}"`;
      }
      out.push({ ...(NON_EMPTY_STR(a.id) ? { id: a.id } : {}), type: a.type, config: (a.config ?? {}) as Record<string, unknown> });
      continue;
    }
    const c = (a.config ?? {}) as Partial<EmailActionConfig>;
    if (!NON_EMPTY_STR(c.to)) return 'Each email action needs a "to" (recipient or {{field}})';
    if (!NON_EMPTY_STR(c.subject)) return 'Each email action needs a "subject"';
    if (!NON_EMPTY_STR(c.body)) return 'Each email action needs a "body"';
    if (c.format !== undefined && c.format !== 'html' && c.format !== 'text') {
      return 'format must be "html" or "text"';
    }
    const config: EmailActionConfig = {
      to: c.to,
      subject: c.subject,
      body: c.body,
      ...(NON_EMPTY_STR(c.cc) ? { cc: c.cc } : {}),
      ...(NON_EMPTY_STR(c.bcc) ? { bcc: c.bcc } : {}),
      ...(NON_EMPTY_STR(c.reply_to) ? { reply_to: c.reply_to } : {}),
      ...(c.include_all ? { include_all: true } : {}),
      ...(c.format ? { format: c.format } : {}),
    };
    out.push({ ...(NON_EMPTY_STR(a.id) ? { id: a.id } : {}), type: 'email', config: config as unknown as Record<string, unknown> });
  }
  return out;
}

/** Form actions safe for the cookie-auth admin UI. Ciphertext never leaves the server. */
export function maskFormActionsForAdmin(actions: FormAction[] = []): FormAction[] {
  return actions.map((action) => {
    if (action.type !== 'webhook') {
      const config: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(action.config ?? {})) {
        if (key.endsWith('_enc')) config[key.slice(0, -4)] = SECRET_MASK;
        else config[key] = value;
      }
      return { ...action, config };
    }
    return {
      id: action.id,
      type: action.type,
      config: {
        url: action.config.url ?? '',
        fields: Array.isArray(action.config.fields) ? action.config.fields.join(', ') : '',
        secret: action.config.secret_enc ? SECRET_MASK : '',
      },
    };
  });
}

// ─── HTML-mode form reference ────────────────────────────────────────────

/**
 * Authoring directive for an HTML-mode page. Static generation and preview
 * replace it with the complete `core/form` shell, including signed token,
 * initial step state, styles, and the shared platform runtime.
 */
export function buildFormEmbedDirective(formId: string): string {
  return `<x-form id="${formId}" />`;
}
