// Forms 2.0 field-block family (`form/*`). Steps in a funnel are ordinary
// Block[] trees; these blocks are the input leaves. Everything renders as
// NATIVE HTML elements styled via the shared --form-* tokens — no JS
// widgets where the platform can do without (the slider's value readout
// is handled by the forms runtime; the help block is a plain <details>).
//
// Conventions every input block follows:
//   - `name` is the wire name (input name= / submission key).
//   - input id = `ff-{name}` and the label points at it.
//   - `required` renders as data-required="{{required}}" — HTML's bare
//     `required` attribute can't be conditionally emitted by the template
//     engine (presence = true, so required="false" would still block).
//     The forms runtime promotes data-required to the real property; the
//     server validates regardless, so the no-JS path stays correct.
//   - every field carries an empty error slot the runtime/server fills:
//     <p class="form-field-error" data-error-for="{name}" hidden></p>
//
// See docs/plans/forms-funnels.md.

import type { BlockType } from './types.js';

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';

/** Shared styles emitted once per bundle via the form/text block. */
const FIELD_BASE_CSS = `
.form-field { display: flex; flex-direction: column; gap: 0.35rem; margin: 0 0 1.1rem; }
.form-field > label { font-weight: 600; font-size: 0.95rem; color: var(--form-label-color, var(--color-text, inherit)); }
.form-field-help { margin: 0; font-size: 0.85rem; color: var(--color-text-light, #6b7280); }
.form-field-error { margin: 0; font-size: 0.85rem; font-weight: 600; color: var(--form-error-color, #b3261e); }
.form-input {
  font: inherit; color: inherit; width: 100%;
  background: var(--form-field-bg, var(--color-surface, #fff));
  border: var(--form-field-border, 1px solid rgba(0,0,0,0.18));
  border-radius: var(--form-field-radius, 0.5rem);
  padding: var(--form-field-pad, 0.65rem 0.85rem);
}
.form-input:focus-visible { outline: 2px solid var(--form-focus-color, var(--color-primary, #1a1a2e)); outline-offset: 1px; }
.form-field[data-invalid] .form-input { border-color: var(--form-error-color, #b3261e); }
`.trim();

function inputBlock(args: {
  id: string;
  name: string;
  label: string;
  inputType: string;
  icon: string;
  extraSchema?: BlockType['schema'];
  extraAttrs?: string;
}): BlockType {
  return {
    id: args.id,
    name: args.name,
    label: args.label,
    icon: args.icon,
    category: 'content',
    container: false,
    schema: [
      { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
      { name: 'label', type: 'text', label: 'Label', required: true },
      { name: 'placeholder', type: 'text', label: 'Placeholder' },
      { name: 'help', type: 'text', label: 'Help text' },
      { name: 'required', type: 'boolean', label: 'Required', default: false },
      ...(args.extraSchema ?? []),
    ],
    template: `<div data-block="${args.name}" class="form-field" data-field="{{name}}">
  <label for="ff-{{name}}">{{label}}</label>
  <input class="form-input" id="ff-{{name}}" name="{{name}}" type="${args.inputType}" placeholder="{{placeholder}}" data-required="{{required}}"${args.extraAttrs ?? ''} />
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
    styles: '',
    origin: 'core',
    created_at: ISO_EPOCH,
  };
}

const formText: BlockType = {
  ...inputBlock({ id: 'form/text', name: 'form_text', label: 'Text field', inputType: 'text', icon: 'type' }),
  // Base CSS rides on the most common block so it ships once per bundle.
  styles: FIELD_BASE_CSS,
};
const formEmail = inputBlock({ id: 'form/email', name: 'form_email', label: 'Email field', inputType: 'email', icon: 'mail', extraAttrs: ' autocomplete="email" inputmode="email"' });
const formPhone = inputBlock({ id: 'form/phone', name: 'form_phone', label: 'Phone field', inputType: 'tel', icon: 'phone', extraAttrs: ' autocomplete="tel" inputmode="tel"' });
const formUrl = inputBlock({ id: 'form/url', name: 'form_url', label: 'URL field', inputType: 'url', icon: 'link' });
const formNumber = inputBlock({
  id: 'form/number', name: 'form_number', label: 'Number field', inputType: 'number', icon: 'plus',
  extraSchema: [
    { name: 'min', type: 'number', label: 'Min' },
    { name: 'max', type: 'number', label: 'Max' },
  ],
  extraAttrs: ' min="{{min}}" max="{{max}}"',
});

const formTextarea: BlockType = {
  id: 'form/textarea',
  name: 'form_textarea',
  label: 'Text area',
  icon: 'file-text',
  category: 'content',
  container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
    { name: 'label', type: 'text', label: 'Label', required: true },
    { name: 'placeholder', type: 'text', label: 'Placeholder' },
    { name: 'help', type: 'text', label: 'Help text' },
    { name: 'required', type: 'boolean', label: 'Required', default: false },
    { name: 'rows', type: 'number', label: 'Rows', default: 4 },
  ],
  template: `<div data-block="form_textarea" class="form-field" data-field="{{name}}">
  <label for="ff-{{name}}">{{label}}</label>
  <textarea class="form-input" id="ff-{{name}}" name="{{name}}" rows="{{rows}}" placeholder="{{placeholder}}" data-required="{{required}}"></textarea>
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
  // field-sizing is progressive enhancement (autosize where supported)
  styles: `[data-block="form_textarea"] textarea { resize: vertical; field-sizing: content; min-height: 5.5rem; }`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

function choicesBlock(args: {
  id: string; name: string; label: string; icon: string;
  markup: 'select' | 'radio' | 'checkbox';
  template: string; styles?: string;
}): BlockType {
  return {
    id: args.id,
    name: args.name,
    label: args.label,
    icon: args.icon,
    category: 'content',
    container: false,
    schema: [
      { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
      { name: 'label', type: 'text', label: 'Label', required: true },
      { name: 'help', type: 'text', label: 'Help text' },
      { name: 'required', type: 'boolean', label: 'Required', default: false },
      {
        name: 'choices', type: 'choices', label: 'Choices', choices_markup: args.markup,
        fields: [
          { name: 'value', type: 'text', label: 'Value' },
          { name: 'label', type: 'text', label: 'Label' },
        ],
      },
    ],
    template: args.template,
    styles: args.styles ?? '',
    origin: 'core',
    created_at: ISO_EPOCH,
  };
}

const formSelect = choicesBlock({
  id: 'form/select', name: 'form_select', label: 'Select', icon: 'chevron-down', markup: 'select',
  template: `<div data-block="form_select" class="form-field" data-field="{{name}}">
  <label for="ff-{{name}}">{{label}}</label>
  <select class="form-input" id="ff-{{name}}" name="{{name}}" data-required="{{required}}">{{{choices_options_html}}}</select>
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
});

const GROUP_CSS = `
.form-choice { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
.form-choice input { width: 1.05rem; height: 1.05rem; accent-color: var(--form-accent-color, var(--color-primary, #1a1a2e)); }
`.trim();

const formRadioGroup = choicesBlock({
  id: 'form/radio_group', name: 'form_radio_group', label: 'Radio group', icon: 'circle-check', markup: 'radio',
  template: `<fieldset data-block="form_radio_group" class="form-field" data-field="{{name}}">
  <legend>{{label}}</legend>
  {{{choices_options_html}}}
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</fieldset>`,
  styles: `[data-block="form_radio_group"] { border: 0; padding: 0; margin: 0 0 1.1rem; }
[data-block="form_radio_group"] legend { font-weight: 600; font-size: 0.95rem; padding: 0 0 0.35rem; }
${GROUP_CSS}`,
});

const formCheckboxGroup = choicesBlock({
  id: 'form/checkbox_group', name: 'form_checkbox_group', label: 'Checkbox group', icon: 'check', markup: 'checkbox',
  template: `<fieldset data-block="form_checkbox_group" class="form-field" data-field="{{name}}">
  <legend>{{label}}</legend>
  {{{choices_options_html}}}
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</fieldset>`,
  styles: `[data-block="form_checkbox_group"] { border: 0; padding: 0; margin: 0 0 1.1rem; }
[data-block="form_checkbox_group"] legend { font-weight: 600; font-size: 0.95rem; padding: 0 0 0.35rem; }`,
});

const formToggle: BlockType = {
  id: 'form/toggle',
  name: 'form_toggle',
  label: 'Toggle',
  icon: 'check',
  category: 'content',
  container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
    { name: 'label', type: 'text', label: 'Label', required: true },
    { name: 'help', type: 'text', label: 'Help text' },
  ],
  // A checkbox styled as a switch — pure CSS, no JS.
  template: `<div data-block="form_toggle" class="form-field form-field--inline" data-field="{{name}}">
  <label class="form-toggle">
    <input type="checkbox" id="ff-{{name}}" name="{{name}}" value="yes" />
    <span class="form-toggle-track" aria-hidden="true"></span>
    <span>{{label}}</span>
  </label>
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
  styles: `
[data-block="form_toggle"] .form-toggle { display: inline-flex; align-items: center; gap: 0.6rem; cursor: pointer; }
[data-block="form_toggle"] input { position: absolute; opacity: 0; width: 1px; height: 1px; }
[data-block="form_toggle"] .form-toggle-track {
  flex: 0 0 auto; width: 2.4rem; height: 1.35rem; border-radius: 999px;
  background: var(--form-toggle-off, rgba(0,0,0,0.25)); position: relative; transition: background .15s ease;
}
[data-block="form_toggle"] .form-toggle-track::after {
  content: ""; position: absolute; top: 0.15rem; left: 0.15rem; width: 1.05rem; height: 1.05rem;
  border-radius: 50%; background: #fff; transition: transform .15s ease;
}
[data-block="form_toggle"] input:checked + .form-toggle-track { background: var(--form-accent-color, var(--color-primary, #1a1a2e)); }
[data-block="form_toggle"] input:checked + .form-toggle-track::after { transform: translateX(1.05rem); }
[data-block="form_toggle"] input:focus-visible + .form-toggle-track { outline: 2px solid var(--form-focus-color, var(--color-primary, #1a1a2e)); outline-offset: 2px; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const formSlider: BlockType = {
  id: 'form/slider',
  name: 'form_slider',
  label: 'Slider',
  icon: 'minus',
  category: 'content',
  container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
    { name: 'label', type: 'text', label: 'Label', required: true },
    { name: 'min', type: 'number', label: 'Min', default: 0 },
    { name: 'max', type: 'number', label: 'Max', default: 100 },
    { name: 'step', type: 'number', label: 'Step', default: 1 },
    { name: 'unit', type: 'text', label: 'Unit suffix (e.g. "kr")' },
    { name: 'help', type: 'text', label: 'Help text' },
  ],
  // The forms runtime mirrors the value into .form-slider-value (no-JS
  // fallback: the native control still works, the readout stays empty).
  template: `<div data-block="form_slider" class="form-field" data-field="{{name}}" data-unit="{{unit}}">
  <label for="ff-{{name}}">{{label}} <output class="form-slider-value" for="ff-{{name}}"></output></label>
  <input type="range" id="ff-{{name}}" name="{{name}}" min="{{min}}" max="{{max}}" step="{{step}}" />
  <p class="form-field-help">{{help}}</p>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
  styles: `
[data-block="form_slider"] input[type="range"] { width: 100%; accent-color: var(--form-accent-color, var(--color-primary, #1a1a2e)); }
[data-block="form_slider"] .form-slider-value { font-weight: 700; margin-left: 0.4rem; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const formDate = inputBlock({ id: 'form/date', name: 'form_date', label: 'Date field', inputType: 'date', icon: 'calendar' });

const formHeading: BlockType = {
  id: 'form/heading',
  name: 'form_heading',
  label: 'Form section heading',
  icon: 'heading',
  category: 'content',
  container: false,
  schema: [
    { name: 'text', type: 'text', label: 'Heading', required: true },
    { name: 'description', type: 'text', label: 'Intro line' },
  ],
  template: `<div data-block="form_heading" class="form-section-heading">
  <h3>{{text}}</h3>
  <p>{{description}}</p>
</div>`,
  styles: `
[data-block="form_heading"] h3 { margin: 1.4rem 0 0.2rem; font-size: 1.15rem; }
[data-block="form_heading"] p { margin: 0 0 0.8rem; color: var(--color-text-light, #6b7280); }
[data-block="form_heading"] p:empty { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const formHelp: BlockType = {
  id: 'form/help',
  name: 'form_help',
  label: 'Expandable help',
  icon: 'circle-help',
  category: 'content',
  container: false,
  schema: [
    { name: 'summary', type: 'text', label: 'Question / summary', required: true },
    { name: 'body', type: 'richtext', label: 'Help content' },
  ],
  // Native <details> — zero JS.
  template: `<details data-block="form_help" class="form-help">
  <summary>{{summary}}</summary>
  <div class="form-help-body">{{{body}}}</div>
</details>`,
  styles: `
[data-block="form_help"] { margin: 0 0 1.1rem; border: var(--form-field-border, 1px solid rgba(0,0,0,0.18)); border-radius: var(--form-field-radius, 0.5rem); padding: 0.6rem 0.85rem; }
[data-block="form_help"] summary { cursor: pointer; font-weight: 600; font-size: 0.95rem; }
[data-block="form_help"] .form-help-body { padding-top: 0.5rem; font-size: 0.9rem; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const formConsent: BlockType = {
  id: 'form/consent',
  name: 'form_consent',
  label: 'Consent checkbox',
  icon: 'shield-check',
  category: 'content',
  container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Field name (wire name)', required: true, default: 'consent' },
    { name: 'text', type: 'richtext', label: 'Consent text (may contain links)', required: true },
  ],
  template: `<div data-block="form_consent" class="form-field form-field--inline" data-field="{{name}}">
  <label class="form-choice">
    <input type="checkbox" id="ff-{{name}}" name="{{name}}" value="yes" data-required="true" />
    <span class="form-consent-text">{{{text}}}</span>
  </label>
  <p class="form-field-error" data-error-for="{{name}}" hidden></p>
</div>`,
  styles: `
[data-block="form_consent"] .form-choice { align-items: flex-start; }
[data-block="form_consent"] input { margin-top: 0.2rem; width: 1.05rem; height: 1.05rem; accent-color: var(--form-accent-color, var(--color-primary, #1a1a2e)); }
[data-block="form_consent"] .form-consent-text { font-size: 0.9rem; }
[data-block="form_consent"] .form-consent-text p { margin: 0; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const formHidden: BlockType = {
  id: 'form/hidden',
  name: 'form_hidden',
  label: 'Hidden field',
  icon: 'eye',
  category: 'content',
  container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Field name (wire name)', required: true },
    { name: 'value', type: 'text', label: 'Value' },
  ],
  template: `<input data-block="form_hidden" type="hidden" name="{{name}}" value="{{value}}" />`,
  styles: '',
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const FORM_BLOCK_TYPES: BlockType[] = [
  formText,
  formEmail,
  formPhone,
  formUrl,
  formNumber,
  formTextarea,
  formSelect,
  formRadioGroup,
  formCheckboxGroup,
  formToggle,
  formSlider,
  formDate,
  formHeading,
  formHelp,
  formConsent,
  formHidden,
];
