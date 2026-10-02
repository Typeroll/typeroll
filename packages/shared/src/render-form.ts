// Forms 2.0 form-shell renderer. Produces the full <form> markup for a
// steps-mode Form: step 1 visible, remaining STATIC steps prerendered but
// hidden (the runtime swaps locally — no server round-trip for step
// changes), one container for server-rendered DYNAMIC step html, hidden
// control fields (_token, _state, _hp honeypot) and the PoW difficulty.
// Used by the SSG (core/form blocks via RenderBlocksOptions.formSource),
// the portal preview, and nothing else — the submit endpoint renders
// single dynamic steps via renderBlocks directly.

import { renderBlocks, escapeHtml, type RenderBlocksOptions } from './render-blocks.js';
import type { Form, FormField } from './types.js';
import { FORM_BLOCKS_CSS } from './form-blocks.js';
import { collectStepFields, defaultErrorMessage, isCheckboxGroupField, nextStep, type FieldError } from './form-fields.js';

export interface FormEmbed {
  submit_url: string;
  submit_token: string | null;
  /**
   * Preview mode (portal previews only — the static build never sets it):
   * the forms runtime validates and advances steps in the browser and shows
   * the success message or the redirect target, but sends nothing. The form
   * carries no submit token and a `_preview` marker the submit endpoint
   * refuses, so a preview can never create a submission.
   */
  preview?: boolean;
}

// Inline so the shared shell CSS (and every published page) stays unchanged.
const PREVIEW_NOTICE_STYLE = 'display:inline-block;margin:0 0 1rem;padding:0.2rem 0.6rem;font-size:0.8125rem;font-weight:600;line-height:1.4;border:1px dashed currentColor;border-radius:999px;opacity:0.8';

/** Wire marker posted by preview forms; the submit endpoint refuses it. */
export const FORM_PREVIEW_FIELD = '_preview';

/** One field of a preview step, with the server's messages resolved. */
export interface FormPreviewField {
  name: string;
  type: string;
  required?: true;
  /** A checkbox group: the answer is the list of ticked values. */
  list?: true;
  pattern?: string;
  min?: number;
  max?: number;
  /** Message per error code this field can produce. */
  messages: Partial<Record<FieldError['code'], string>>;
}

export interface FormPreviewStep {
  id: string;
  /** The step shown after this one; null completes the form. */
  next: string | null;
  fields: FormPreviewField[];
}

/**
 * The step graph and field rules the runtime needs to simulate the submit
 * endpoint in a preview: same fields (collectStepFields), same order
 * (nextStep), same messages (defaultErrorMessage) as the server.
 */
export function formPreviewSteps(form: Form, lang = 'en'): FormPreviewStep[] {
  return (form.steps ?? []).map((step) => ({
    id: step.id,
    next: nextStep(form, step)?.id ?? null,
    fields: collectStepFields(step.blocks).map((field) => previewField(field, lang)),
  }));
}

function previewField(field: FormField, lang: string): FormPreviewField {
  const codes: FieldError['code'][] = [];
  if (field.required) codes.push('required');
  if (field.type === 'boolean') codes.push('invalid_boolean');
  if (field.type === 'email') codes.push('invalid_email');
  if (field.pattern) codes.push('pattern');
  if (field.min !== undefined) codes.push('min');
  if (field.max !== undefined) codes.push('max');
  const label = field.label ?? field.name;
  return {
    name: field.name,
    type: field.type,
    ...(field.required ? { required: true as const } : {}),
    ...(isCheckboxGroupField(field) ? { list: true as const } : {}),
    ...(field.pattern ? { pattern: field.pattern } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    messages: Object.fromEntries(codes.map((code) => [code, field.error_messages?.[code] ?? defaultErrorMessage(code, label, lang)])),
  };
}

/**
 * Where a completed form may send the visitor: an absolute http(s) URL or a
 * root-relative path. Protocol-relative, scriptable and other schemes are
 * refused so a stored setting can never become a javascript: navigation.
 */
export function safeFormRedirectUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || /[\u0000-\u0020]/.test(url)) return '';
  if (/^\/(?![/\\])/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export interface RenderFormOptions {
  registry: RenderBlocksOptions['registry'];
  /** Proof-of-work difficulty in leading zero bits. 0 disables. */
  pow_bits?: number;
  submit_label?: string;
  lang?: string;
}

export function renderFormHtml(form: Form, embed: FormEmbed, opts: RenderFormOptions): string {
  // Steps are the only form model — a flat `fields` list is converted to a
  // single step at WRITE time (fieldsToSteps), so a stored form without
  // steps is an empty/broken doc, not a legacy shape.
  const steps = form.steps ?? [];
  if (steps.length === 0) return `<!-- form ${escapeHtml(form.id)} has no steps -->`;
  const sv = (opts.lang ?? '').startsWith('sv');
  const submitLabel = opts.submit_label ?? form.submit_text ?? (sv ? 'Skicka' : 'Send');
  const failMsg = sv ? 'Något gick fel — försök igen.' : 'Something went wrong — please try again.';
  const doneMsg = form.success_message ?? (sv ? 'Tack!' : 'Thanks!');
  // Optional: navigate to a thank-you or booking page after the final step.
  const redirect = safeFormRedirectUrl(form.success_redirect_url);

  const preview = embed.preview === true;
  const stepHtml = steps
    .map((step, i) => {
      // Dynamic steps are rendered by the forms service at submit time. A
      // preview has no forms service; their blocks render the same either
      // way (no submitted values reach them), so it prerenders them.
      if (step.render === 'dynamic' && !preview) return '';
      const body = renderBlocks(step.blocks ?? [], { registry: opts.registry });
      const title = step.title ? `<h3 class="form-step-title">${escapeHtml(step.title)}</h3>` : '';
      return `<div data-form-step="${escapeHtml(step.id)}"${i === 0 ? '' : ' hidden'}>${title}${body}</div>`;
    })
    .join('\n');

  const styles = form.styles
    ? `<style data-form-styles="${escapeHtml(form.id)}">${String(form.styles).replace(/<\/style/gi, '<\\/style')}</style>`
    : '';

  // Generic capability flags. Deliberately NOT the app's name — the runtime
  // implements "prefill from the endpoint" and "exchange a one-time token for
  // a session", and any app that wants either gets them by declaring them.
  const hydrate = form.target?.hydrate ? ' data-tr-hydrate="1"' : '';
  const sessionParam = form.target?.session_param
    ? ` data-tr-session-param="${escapeHtml(form.target.session_param)}"`
    : '';

  // Preview: nothing to sign or prove, and the runtime needs the step graph
  // and the server's validation rules to simulate the submit endpoint.
  const previewAttrs = preview
    ? ` data-tr-preview="${escapeHtml(JSON.stringify(formPreviewSteps(form, opts.lang)))}" data-msg-redirect="${escapeHtml(sv ? 'Förhandsvisning – skulle skicka vidare till' : 'Preview – would redirect to')}"`
    : '';
  const previewHtml = preview
    ? `<input type="hidden" name="${FORM_PREVIEW_FIELD}" value="1" />
<p class="form-preview-notice" role="note" style="${PREVIEW_NOTICE_STYLE}">${sv ? 'Förhandsvisning – inget skickas' : 'Preview – nothing is sent'}</p>
`
    : '';

  return `<div data-tr-form="${escapeHtml(form.id)}"${hydrate}${sessionParam} data-tr-context-params="${escapeHtml(JSON.stringify(form.target?.context_params ?? []))}">
${styles}<form data-tr-form-el method="POST" action="${escapeHtml(embed.submit_url)}" data-pow-bits="${preview ? 0 : (opts.pow_bits ?? 0)}" data-msg-fail="${escapeHtml(failMsg)}" data-msg-done="${escapeHtml(doneMsg)}"${redirect ? ` data-redirect="${escapeHtml(redirect)}"` : ''}${previewAttrs}>
${previewHtml}<input type="hidden" name="_token" value="${escapeHtml(preview ? '' : (embed.submit_token ?? ''))}" />
<input type="hidden" name="_state" value="" />
<input type="hidden" name="_form_id" value="${escapeHtml(form.id)}" />
<input type="text" name="_hp" class="form-hp" hidden tabindex="-1" autocomplete="off" aria-hidden="true" />
<p class="form-toplevel-error form-field-error" hidden tabindex="-1"></p>
${stepHtml}
<div data-form-dynamic-step hidden></div>
<button type="submit" class="form-submit">${escapeHtml(submitLabel)}</button>
</form>
</div>`;
}

/** Shell styles shipped once per bundle (rides with the runtime include). */
export const FORM_SHELL_CSS = `
${FORM_BLOCKS_CSS}
[data-tr-form] .form-hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
[data-tr-form] .form-step-title { margin: 0 0 1rem; }
[data-tr-form] .form-submit {
  font: inherit; font-weight: 600; cursor: pointer; border: 0;
  background: var(--form-accent-color, var(--color-primary, #111));
  color: var(--color-primary-fg, #fff);
  border-radius: var(--form-field-radius, 0.5rem);
  padding: 0.8rem 1.6rem; margin-top: 0.4rem;
}
[data-tr-form] .form-submit[disabled] { opacity: 0.6; cursor: progress; }
[data-tr-form] .form-done { padding: 1rem 0; font-weight: 600; }
`.trim();
