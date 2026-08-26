// Forms 2.0 form-shell renderer. Produces the full <form> markup for a
// steps-mode Form: step 1 visible, remaining STATIC steps prerendered but
// hidden (the runtime swaps locally — no server round-trip for step
// changes), one container for server-rendered DYNAMIC step html, hidden
// control fields (_token, _state, _hp honeypot) and the PoW difficulty.
// Used by the SSG (core/form blocks via RenderBlocksOptions.formSource),
// the portal preview, and nothing else — the submit endpoint renders
// single dynamic steps via renderBlocks directly.

import { renderBlocks, escapeHtml, type RenderBlocksOptions } from './render-blocks.js';
import type { Form } from './types.js';

export interface FormEmbed {
  submit_url: string;
  submit_token: string | null;
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

  const stepHtml = steps
    .map((step, i) => {
      // Dynamic steps are rendered by the forms service at submit time.
      if (step.render === 'dynamic') return '';
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

  return `<div data-tr-form="${escapeHtml(form.id)}"${hydrate}${sessionParam}>
${styles}<form data-tr-form-el method="POST" action="${escapeHtml(embed.submit_url)}" data-pow-bits="${opts.pow_bits ?? 0}" data-msg-fail="${escapeHtml(failMsg)}" data-msg-done="${escapeHtml(doneMsg)}">
<input type="hidden" name="_token" value="${escapeHtml(embed.submit_token ?? '')}" />
<input type="hidden" name="_state" value="" />
<input type="hidden" name="_form_id" value="${escapeHtml(form.id)}" />
<input type="text" name="_hp" class="form-hp" tabindex="-1" autocomplete="off" aria-hidden="true" />
<p class="form-toplevel-error form-field-error" hidden tabindex="-1"></p>
${stepHtml}
<div data-form-dynamic-step hidden></div>
<button type="submit" class="form-submit">${escapeHtml(submitLabel)}</button>
</form>
</div>`;
}

/** Shell styles shipped once per bundle (rides with the runtime include). */
export const FORM_SHELL_CSS = `
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
