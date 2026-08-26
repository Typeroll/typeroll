// Forms 2.0 server-side helpers: derive field definitions from a step's
// form/* blocks (single source of truth — no duplicated field lists) and
// validate submitted values. Pure functions; used by the submit endpoint
// and unit-testable without a datastore.

import type { Block, Form, FormField, FormStep } from './types.js';

/** Block types that contribute a wire field. */
const FIELD_BLOCK_TYPES = new Set([
  'form/text', 'form/email', 'form/phone', 'form/url', 'form/number', 'form/textarea',
  'form/select', 'form/radio_group', 'form/checkbox_group', 'form/toggle',
  'form/slider', 'form/date', 'form/consent', 'form/hidden',
]);

const TYPE_BY_BLOCK: Record<string, string> = {
  'form/text': 'text',
  'form/email': 'email',
  'form/phone': 'tel',
  'form/url': 'url',
  'form/number': 'number',
  'form/textarea': 'textarea',
  'form/select': 'select',
  'form/radio_group': 'radio',
  'form/checkbox_group': 'checkbox',
  'form/toggle': 'checkbox',
  'form/slider': 'number',
  'form/date': 'date',
  'form/consent': 'gdpr_consent',
  'form/hidden': 'hidden',
};

/** Walk a step's block tree and derive its FormField definitions. */
export function collectStepFields(blocks: Block[] | undefined): FormField[] {
  const out: FormField[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (FIELD_BLOCK_TYPES.has(b.type)) {
        const d = (b.data ?? {}) as Record<string, unknown>;
        const name = String(d.name ?? '').trim();
        if (name) {
          out.push({
            name,
            type: TYPE_BY_BLOCK[b.type] ?? 'text',
            label: String(b.type === 'form/consent' ? (d.text ?? name) : (d.label ?? name)),
            required: b.type === 'form/consent' ? true : d.required === true,
            placeholder: typeof d.placeholder === 'string' ? d.placeholder : undefined,
            options: Array.isArray(d.choices)
              ? d.choices.map((choice) => String((choice as { value?: unknown; label?: unknown }).value ?? (choice as { label?: unknown }).label ?? ''))
              : undefined,
            default: b.type === 'form/hidden' ? d.value : undefined,
            pattern: typeof d.pattern === 'string' ? d.pattern : undefined,
            min: typeof d.min === 'number' ? d.min : undefined,
            max: typeof d.max === 'number' ? d.max : undefined,
          });
        }
      }
      if (b.children) walk(b.children);
      for (const slot of b.slots ?? []) walk(slot);
    }
  };
  walk(blocks ?? []);
  return out;
}

export function getStep(form: Form, stepId: string | undefined): FormStep | undefined {
  const steps = form.steps ?? [];
  if (!stepId) return steps[0];
  return steps.find((s) => s.id === stepId);
}

/** Next step per `next` override or list order; undefined → done. */
export function nextStep(form: Form, current: FormStep): FormStep | undefined {
  const steps = form.steps ?? [];
  if (current.next) return steps.find((s) => s.id === current.next);
  const i = steps.findIndex((s) => s.id === current.id);
  return i >= 0 ? steps[i + 1] : undefined;
}

export interface FieldError {
  field: string;
  code: 'required' | 'invalid_email' | 'pattern' | 'min' | 'max';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Validate submitted values against field defs. Messages resolved by caller. */
export function validateFieldValues(
  fields: FormField[],
  data: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const f of fields) {
    const raw = data[f.name];
    const str = raw == null ? '' : String(raw).trim();
    if (f.required && str === '') {
      errors.push({ field: f.name, code: 'required' });
      continue;
    }
    if (str === '') continue;
    if (f.type === 'email' && !EMAIL_RE.test(str)) {
      errors.push({ field: f.name, code: 'invalid_email' });
      continue;
    }
    if (f.pattern) {
      try {
        if (!new RegExp(`^(?:${f.pattern})$`).test(str)) {
          errors.push({ field: f.name, code: 'pattern' });
          continue;
        }
      } catch { /* invalid author regex — skip, never block visitors */ }
    }
    if (f.type === 'number') {
      const n = Number(str);
      if (f.min !== undefined && n < f.min) errors.push({ field: f.name, code: 'min' });
      else if (f.max !== undefined && n > f.max) errors.push({ field: f.name, code: 'max' });
    } else {
      if (f.min !== undefined && str.length < f.min) errors.push({ field: f.name, code: 'min' });
      else if (f.max !== undefined && str.length > f.max) errors.push({ field: f.name, code: 'max' });
    }
  }
  return errors;
}

/** Default visitor-facing messages (sv + en); Form.fields error_messages override. */
export function defaultErrorMessage(code: FieldError['code'], label: string, lang: string): string {
  const sv = lang.startsWith('sv');
  switch (code) {
    case 'required': return sv ? `${label} måste fyllas i` : `${label} is required`;
    case 'invalid_email': return sv ? `${label} ser inte ut som en giltig e-postadress` : `${label} doesn't look like a valid email address`;
    case 'pattern': return sv ? `${label} har fel format` : `${label} has the wrong format`;
    case 'min': return sv ? `${label} är för kort/lågt` : `${label} is too short/low`;
    case 'max': return sv ? `${label} är för långt/högt` : `${label} is too long/high`;
  }
}

/**
 * Convert a flat `fields[]` list into form/* field blocks — the WRITE-TIME
 * half of the "fields is just sugar" model. create_form / update_form
 * accept a flat field list for simple forms; the server stores it as a
 * single static step. Steps are the ONLY stored form model.
 *
 * Every field type has a canonical block target; unknown types fall back
 * to `form/text` so a form never renders half-empty.
 */
export function fieldsToStepBlocks(fields: FormField[]): Block[] {
  return fields.map((f) => {
    const id = `f-${f.name}`;
    const base: Record<string, unknown> = {
      name: f.name,
      label: f.label,
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
    };
    const choices = (f.options ?? []).map((o) => ({ value: o, label: o }));
    switch (f.type) {
      case 'email': return { id, type: 'form/email', data: base };
      case 'tel': return { id, type: 'form/phone', data: base };
      case 'number': return {
        id, type: 'form/number',
        data: { ...base, ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) },
      };
      case 'textarea': return { id, type: 'form/textarea', data: base };
      case 'select': return { id, type: 'form/select', data: { ...base, choices } };
      case 'radio': return { id, type: 'form/radio_group', data: { ...base, choices } };
      case 'checkbox': return choices.length > 0
        ? { id, type: 'form/checkbox_group', data: { ...base, choices } }
        : { id, type: 'form/toggle', data: base };
      case 'hidden': return { id, type: 'form/hidden', data: { name: f.name, value: String(f.default ?? '') } };
      case 'gdpr_consent': return { id, type: 'form/consent', data: { name: f.name, text: f.label } };
      case 'url': return { id, type: 'form/url', data: base };
      case 'text':
      default:
        return { id, type: 'form/text', data: base };
    }
  });
}

/** The whole sugar-to-model conversion: flat fields → a one-step Form.steps. */
export function fieldsToSteps(fields: FormField[]): FormStep[] {
  return [{ id: 'main', blocks: fieldsToStepBlocks(fields) }];
}
