// Forms 2.0 form-shell renderer. Produces the full <form> markup for a
// steps-mode Form: step 1 visible, remaining STATIC steps prerendered but
// hidden (the runtime swaps locally — no server round-trip for step
// changes), one container for server-rendered DYNAMIC step html, hidden
// control fields (_token, _state, _hp honeypot) and the PoW difficulty.
// Used by the SSG (core/form blocks via RenderBlocksOptions.formSource),
// the portal preview, and nothing else — the submit endpoint renders
// single dynamic steps via renderBlocks directly.

import { renderBlocks, escapeHtml, type RenderBlocksOptions } from './render-blocks.js';
import type { Block, Form, FormField, FormStep } from './types.js';
import { BOOLEAN_LABELS, FORM_BLOCKS_CSS } from './form-blocks.js';
import { collectStepFields, defaultErrorMessage, formMessage, formStepPath, isCheckboxGroupField, nextStep, showsStepTitle, type FieldError, type FormMessageKey } from './form-fields.js';
import { resolveRenderVersion } from './render-version.js';

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
  /**
   * Cloudflare Turnstile site key. When set, the form renders a Turnstile
   * widget and the runtime sends its answer as `cf-turnstile-response`.
   */
  turnstile_site_key?: string | null;
}

// Inline so the shared shell CSS (and every published page) stays unchanged.
const PREVIEW_NOTICE_STYLE = 'display:inline-block;margin:0 0 1rem;padding:0.2rem 0.6rem;font-size:0.8125rem;font-weight:600;line-height:1.4;border:1px dashed currentColor;border-radius:999px;opacity:0.8';

/** Runtime messages of remote-backed forms: data-msg-{attribute} → text. */
const REMOTE_MESSAGES: ReadonlyArray<readonly [string, FormMessageKey]> = [
  ['loading', 'loading'],
  ['expired', 'link_expired'],
  ['retry-hour', 'retry_hour'],
  ['retry-hours', 'retry_hours'],
  ['work-email', 'work_email'],
  ['work-email-limit', 'work_email_limit'],
  ['or', 'or'],
];

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

/**
 * Where a form sits and how its submit button looks (render version 16).
 * These are core/form block settings: the block passes them to formSource
 * beside its submit label, and the caller hands them on here. Unknown or
 * default values add nothing to the markup.
 */
export interface FormPresentationOptions {
  /** Maximum width of the form in px (240–2400). */
  max_width_px?: unknown;
  /** Where a form narrower than its column sits: start (default), center or end. */
  align?: unknown;
  /** Where the submit (and back) button sits: start (default), center or end. */
  submit_align?: unknown;
  /** auto (default, as wide as its label) or full (the whole row). */
  submit_width?: unknown;
}

/** The presentation settings among a core/form block's options (formSource's second argument). */
export function formPresentationOptions(block: unknown): FormPresentationOptions {
  if (!block || typeof block !== 'object') return {};
  const { max_width_px, align, submit_align, submit_width } = block as Record<string, unknown>;
  return { max_width_px, align, submit_align, submit_width };
}

/** The validated presentation attributes of a form's root, from render version 16. */
function formPresentationAttrs(opts: FormPresentationOptions): string {
  const pick = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : '';
  const align = pick(opts.align, ['center', 'end']);
  const submitAlign = pick(opts.submit_align, ['center', 'end']);
  const submitWidth = pick(opts.submit_width, ['full']);
  const max = typeof opts.max_width_px === 'number' ? opts.max_width_px : typeof opts.max_width_px === 'string' && opts.max_width_px.trim() ? Number(opts.max_width_px) : NaN;
  const maxWidth = Number.isFinite(max) && max >= 240 && max <= 2400 ? Math.round(max) : 0;
  return `${align ? ` data-align="${align}"` : ''}${submitAlign ? ` data-submit-align="${submitAlign}"` : ''}${submitWidth ? ` data-submit-width="${submitWidth}"` : ''}${maxWidth ? ` style="--form-max-width:${maxWidth}px"` : ''}`;
}

export interface RenderFormOptions extends FormPresentationOptions {
  registry: RenderBlocksOptions['registry'];
  /** Proof-of-work difficulty in leading zero bits. 0 disables. */
  pow_bits?: number;
  submit_label?: string;
  lang?: string;
  /**
   * The site's render version. From 5, multi-step forms default to a
   * "Continue" label on every step but the last and a Back button, and a
   * step starting with a form heading omits its title. Missing means 1.
   */
  renderVersion?: number;
}

function progressText(template: string, n: number, total: number): string {
  return template.replace('{n}', String(n)).replace('{total}', String(total));
}

export function renderFormHtml(form: Form, embed: FormEmbed, opts: RenderFormOptions): string {
  // Steps are the only form model — a flat `fields` list is converted to a
  // single step at WRITE time (fieldsToSteps), so a stored form without
  // steps is an empty/broken doc, not a legacy shape.
  const steps = form.steps ?? [];
  if (steps.length === 0) return `<!-- form ${escapeHtml(form.id)} has no steps -->`;
  const lang = opts.lang;
  const submitLabel = opts.submit_label ?? form.submit_text ?? formMessage('submit', lang);
  const failMsg = formMessage('fail', lang);
  const doneMsg = form.success_message ?? formMessage('thanks', lang);
  // Optional: navigate to a thank-you or booking page after the final step.
  const redirect = safeFormRedirectUrl(form.success_redirect_url);

  const preview = embed.preview === true;
  const renderVersion = resolveRenderVersion(opts.renderVersion);
  const multiStep = steps.length > 1;

  // The submit button's text per step: the step's own label, else (render
  // version 5+) "Continue" before the last step, else the form's submit text.
  // Steps carry their label only when one differs, so a form without
  // per-step labels renders exactly as before.
  const continueLabel = renderVersion >= 5 ? formMessage('continue', lang) : submitLabel;
  const labelFor = (step: FormStep) => step.submit_label?.trim() || (nextStep(form, step) ? continueLabel : submitLabel);
  const perStepLabels = steps.some((step) => labelFor(step) !== submitLabel);
  const allowBack = multiStep && (form.allow_back ?? renderVersion >= 5);
  const progress = multiStep && form.show_progress ? (form.show_progress === 'bar' ? 'bar' : 'text') : null;

  const stepHtml = steps
    .map((step, i) => {
      // Dynamic steps are rendered by the forms service at submit time. A
      // preview has no forms service; their blocks render the same either
      // way (no submitted values reach them), so it prerenders them.
      if (step.render === 'dynamic' && !preview) return '';
      return `<div data-form-step="${escapeHtml(step.id)}"${perStepLabels ? ` data-submit-label="${escapeHtml(labelFor(step))}"` : ''}${i === 0 ? '' : ' hidden'}>${formStepBodyHtml(step, opts.registry, renderVersion, lang)}</div>`;
    })
    .join('\n');

  // "Step X of Y" over the steps a visitor passes through. The runtime
  // updates it as steps change; without JS only the first step is reachable.
  let progressHtml = '';
  if (progress) {
    const total = Math.max(1, formStepPath(form).length);
    const template = formMessage('progress', lang);
    progressHtml = `<div class="form-progress" data-form-progress="${progress}" data-progress-template="${escapeHtml(template)}" data-progress-total="${total}"><span class="form-progress-text">${escapeHtml(progressText(template, 1, total))}</span><span class="form-progress-bar" aria-hidden="true"><span class="form-progress-fill" style="width:${Math.round(10000 / total) / 100}%"></span></span></div>\n`;
  }
  // Labels for server-rendered dynamic steps, which the markup can't carry.
  const labelAttrs = perStepLabels
    ? ` data-label-continue="${escapeHtml(continueLabel)}" data-label-final="${escapeHtml(submitLabel)}"`
    : '';
  // Dynamic steps are rendered by the submit endpoint; it needs the render
  // version for their titles.
  const versionAttr = renderVersion >= 5 && steps.some((step) => step.render === 'dynamic')
    ? ` data-render-version="${renderVersion}"`
    : '';
  const backHtml = allowBack
    ? `<button type="button" class="form-back" data-form-back hidden>${escapeHtml(formMessage('back', lang))}</button>\n`
    : '';

  const styles = form.styles
    ? `<style data-form-styles="${escapeHtml(form.id)}">${String(form.styles).replace(/<\/style/gi, '<\\/style')}</style>`
    : '';

  // Generic capability flags. Deliberately NOT the app's name — the runtime
  // implements "prefill from the endpoint" and "exchange a one-time token for
  // a session", and any app that wants either gets them by declaring them.
  const hydrate = form.target?.hydrate ? ' data-tr-hydrate="1"' : '';
  const sessionParam = form.target?.session_param
    ? ` data-tr-session-param="${escapeHtml(form.target.session_param)}"${form.target.session_exchange === 'confirm_post' ? ' data-tr-session-exchange="confirm_post"' : ''}`
    : '';
  // Remote-backed forms show a few runtime messages of their own, in the
  // site's language; ordinary forms don't carry them.
  const remoteMsgAttrs = hydrate || sessionParam
    ? REMOTE_MESSAGES.map(([attr, key]) => ` data-msg-${attr}="${escapeHtml(formMessage(key, lang))}"`).join('')
    : '';

  // Preview: nothing to sign or prove, and the runtime needs the step graph
  // and the server's validation rules to simulate the submit endpoint.
  const previewAttrs = preview
    ? ` data-tr-preview="${escapeHtml(JSON.stringify(formPreviewSteps(form, opts.lang)))}" data-msg-redirect="${escapeHtml(formMessage('preview_redirect', lang))}"`
    : '';
  const previewHtml = preview
    ? `<input type="hidden" name="${FORM_PREVIEW_FIELD}" value="1" />
<p class="form-preview-notice" role="note" style="${PREVIEW_NOTICE_STYLE}">${escapeHtml(formMessage('preview_notice', lang))}</p>
`
    : '';

  // Turnstile renders into this container on the first step only; previews never post.
  const turnstileKey = !preview && embed.turnstile_site_key && /^[0-9A-Za-z_-]{10,128}$/.test(embed.turnstile_site_key) ? embed.turnstile_site_key : '';
  const turnstileHtml = turnstileKey ? `<div class="form-turnstile" data-tr-turnstile="${escapeHtml(turnstileKey)}"></div>\n` : '';
  // Render version 16: the form's own width and alignment, and the buttons
  // in a row of their own that the submit settings align.
  const v16 = renderVersion >= 16;
  const presentation = v16 ? formPresentationAttrs(opts) : '';
  const submitHtml = `<button type="submit" class="form-submit">${escapeHtml(labelFor(steps[0]!))}</button>`;
  const actionsHtml = v16 ? `<div class="form-actions">${backHtml}${submitHtml}</div>` : `${backHtml}${submitHtml}`;
  return `<div data-tr-form="${escapeHtml(form.id)}"${hydrate}${sessionParam} data-tr-context-params="${escapeHtml(JSON.stringify(form.target?.context_params ?? []))}"${presentation}>
${styles}<form data-tr-form-el${!preview && form.option_sources?.length ? ' data-live-options="true"' : ''} method="POST" action="${escapeHtml(embed.submit_url)}" data-pow-bits="${preview ? 0 : (opts.pow_bits ?? 0)}" data-msg-fail="${escapeHtml(failMsg)}" data-msg-done="${escapeHtml(doneMsg)}"${remoteMsgAttrs}${redirect ? ` data-redirect="${escapeHtml(redirect)}"` : ''}${labelAttrs}${versionAttr}${previewAttrs}>
${previewHtml}<input type="hidden" name="_token" value="${escapeHtml(preview ? '' : (embed.submit_token ?? ''))}" />
<input type="hidden" name="_state" value="" />
<input type="hidden" name="_form_id" value="${escapeHtml(form.id)}" />
<input type="text" name="_hp" class="form-hp" hidden tabindex="-1" autocomplete="off" aria-hidden="true" />
<p class="form-toplevel-error form-field-error" hidden tabindex="-1"></p>
${progressHtml}${stepHtml}
<div data-form-dynamic-step hidden></div>
${turnstileHtml}${actionsHtml}
</form>
</div>`;
}

/**
 * A step's title and blocks, as the static shell and the submit endpoint
 * (for dynamic steps) both render them.
 */
export function formStepBodyHtml(step: FormStep, registry: RenderBlocksOptions['registry'], renderVersion: number, lang?: string): string {
  const title = showsStepTitle(step, renderVersion) ? `<h3 class="form-step-title">${escapeHtml(step.title!)}</h3>` : '';
  // Before render version 16 the step's blocks render at the baseline
  // version, exactly as they always have. From 16 they render at the site's
  // version (layered CSS, versioned markup) and a Yes / No answer speaks the
  // site's language.
  if (renderVersion < 16) return `${title}${renderBlocks(step.blocks ?? [], { registry })}`;
  return `${title}${renderBlocks(localizeFormBlocks(step.blocks ?? [], lang), { registry, renderVersion })}`;
}

/** form/boolean texts left empty or at their English default, in the site's language. */
function localizeFormBlocks(blocks: Block[], lang: string | undefined): Block[] {
  return blocks.map((block) => {
    let next = block;
    if (block.type === 'form/boolean') {
      const data: Record<string, unknown> = { ...(block.data ?? {}) };
      for (const [name, , english, key] of BOOLEAN_LABELS) {
        const value = data[name];
        if (value === undefined || value === null || (typeof value === 'string' && (!value.trim() || value === english))) data[name] = formMessage(key, lang);
      }
      next = { ...block, data };
    }
    if (block.children) next = { ...next, children: localizeFormBlocks(block.children, lang) };
    if (block.slots) next = { ...next, slots: block.slots.map((slot) => localizeFormBlocks(slot, lang)) };
    return next;
  });
}

/** Shell styles shipped once per bundle (rides with the runtime include). */
export const FORM_SHELL_CSS = `
${FORM_BLOCKS_CSS}
[data-tr-form] .form-hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
[data-tr-form] [data-form-step][hidden], [data-tr-form] [data-form-dynamic-step][hidden] { display: none !important; }
[data-tr-form] .form-step-title { margin: 0 0 1rem; }
[data-tr-form] .form-submit {
  font: inherit; font-weight: 600; cursor: pointer; border: 0;
  background: var(--form-accent-color, var(--color-primary, #111));
  color: var(--color-primary-fg, #fff);
  border-radius: var(--form-field-radius, 0.5rem);
  padding: 0.8rem 1.6rem; margin-top: 0.4rem;
}
[data-tr-form] .form-submit[disabled] { opacity: 0.6; cursor: progress; }
[data-tr-form] .form-back {
  font: inherit; cursor: pointer; background: transparent;
  color: var(--form-accent-color, var(--color-primary, #111));
  border: 1px solid currentColor;
  border-radius: var(--form-field-radius, 0.5rem);
  padding: calc(0.8rem - 1px) 1.4rem; margin: 0.4rem 0.5rem 0 0;
}
[data-tr-form] .form-back[hidden] { display: none; }
[data-tr-form] .form-progress { margin: 0 0 1rem; font-size: 0.875rem; }
[data-tr-form] .form-progress-bar { display: block; height: 0.25rem; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, currentColor 15%, transparent); }
[data-tr-form] .form-progress-fill { display: block; height: 100%; background: var(--form-accent-color, var(--color-primary, #111)); transition: width 0.2s ease; }
[data-tr-form] [data-form-progress="text"] .form-progress-bar { display: none; }
[data-tr-form] [data-form-progress="bar"] .form-progress-text {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
[data-tr-form] .form-done { padding: 1rem 0; font-weight: 600; }
`.trim();

/**
 * Render version 16 additions to the shell: the form's maximum width and
 * alignment, the button row's alignment and a full-width submit button
 * (core/form settings, see FormPresentationOptions), and field widths: a
 * step whose fields do not all take the full row lays them out in wrapping
 * rows. Without such settings nothing changes.
 */
const FORM_SHELL_V16_CSS = `
[data-tr-form] { max-inline-size: var(--form-max-width, none); }
[data-tr-form][data-align="center"] { margin-inline: auto; }
[data-tr-form][data-align="end"] { margin-inline-start: auto; }
[data-tr-form][data-submit-align="center"] .form-actions { text-align: center; }
[data-tr-form][data-submit-align="end"] .form-actions { text-align: end; }
[data-tr-form][data-submit-width="full"] .form-submit { display: block; inline-size: 100%; }
[data-tr-form] :is([data-form-step], [data-form-dynamic-step]):has(> .form-field[data-width]:not([data-width="full"])) { --form-column-gap: 1rem; display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: var(--form-column-gap); }
[data-tr-form] :where(:is([data-form-step], [data-form-dynamic-step]):has(> .form-field[data-width]:not([data-width="full"]))) > * { flex: 1 1 100%; min-inline-size: 0; }
[data-tr-form] :is([data-form-step], [data-form-dynamic-step]) > .form-field:is([data-width="half"], [data-width="third"], [data-width="two-thirds"]) { min-inline-size: min(100%, 12rem); }
[data-tr-form] :is([data-form-step], [data-form-dynamic-step]) > .form-field[data-width="half"] { flex-basis: calc(50% - var(--form-column-gap) / 2); }
[data-tr-form] :is([data-form-step], [data-form-dynamic-step]) > .form-field[data-width="third"] { flex-basis: calc(100% / 3 - var(--form-column-gap) * 2 / 3); }
[data-tr-form] :is([data-form-step], [data-form-dynamic-step]) > .form-field[data-width="two-thirds"] { flex-basis: calc(200% / 3 - var(--form-column-gap) / 3); }
`.trim();

/** The shell styles for a render version: FORM_SHELL_CSS before 16, with the version 16 additions from it. */
export function formShellCss(renderVersion: number | undefined): string {
  return resolveRenderVersion(renderVersion) >= 16 ? `${FORM_SHELL_CSS}\n${FORM_SHELL_V16_CSS}` : FORM_SHELL_CSS;
}
