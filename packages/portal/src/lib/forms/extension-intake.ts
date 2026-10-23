import { createHash } from 'node:crypto';
import { collectStepFields, validateFieldValues, defaultErrorMessage, paths, type Form, type FormField, type Block } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';

export class IntakeError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface IntakeCondition { source: 'context' | 'answers'; field: string; equals?: string | number | boolean | null; includes?: string }
interface IntakeField extends FormField { option_labels?: string[] }
interface IntakeStep { id: string; title: string; fields: IntakeField[]; when?: IntakeCondition }
interface IntakeSnapshot { steps: IntakeStep[]; context: Record<string, unknown>; reference: Record<string, string>; revision: string }
interface IntakeRecord { form_id: string; installation_id: string; data: Record<string, unknown>; status: 'partial' | 'complete'; intake: IntakeSnapshot; input_digest: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown, label: string) {
  if (!plain(value) || Object.keys(value).length > 100 || Object.keys(value).some(key => forbidden.has(key))) throw new IntakeError(`Invalid ${label}`);
  return value;
}
export function intakeSnapshot(form: Form, context: Record<string, unknown>, conditions: Record<string, unknown>, reference: Record<string, string>): IntakeSnapshot {
  if (!form.steps?.length || form.steps.length > 30) throw new IntakeError('Use a form with 1–30 steps');
  const names = new Set<string>();
  const steps: IntakeStep[] = form.steps.map(step => {
    if (step.render === 'dynamic' || step.next || step.actions?.length) throw new IntakeError('Intake forms use ordered static steps without action hooks');
    const when = conditions[step.id] as IntakeCondition | undefined;
    if (when !== undefined) {
      if (!plain(when) || !['context', 'answers'].includes(when.source) || typeof when.field !== 'string' || forbidden.has(when.field) ||
          (Object.hasOwn(when, 'equals') === Object.hasOwn(when, 'includes')) ||
          (Object.hasOwn(when, 'equals') && when.equals !== null && !['boolean', 'number', 'string'].includes(typeof when.equals)) ||
          (Object.hasOwn(when, 'includes') && typeof when.includes !== 'string')) throw new IntakeError(`Invalid condition for ${step.id}`);
      if (when.source === 'answers' && !names.has(when.field)) throw new IntakeError(`Condition for ${step.id} must refer to a field in an earlier step`);
      if (when.source === 'context' && !Object.hasOwn(context, when.field)) throw new IntakeError(`Missing trusted context field ${when.field}`);
    }
    const labels = new Map<string, string[]>();
    const walk = (blocks: Block[]) => { for (const block of blocks) {
      const data = block.data as Record<string, unknown> | undefined;
      if (typeof data?.name === 'string' && Array.isArray(data.choices)) labels.set(data.name, data.choices.map(choice => String(choice.label ?? choice.value ?? '')));
      walk(block.children ?? []); for (const slot of block.slots ?? []) walk(slot);
    } }; walk(step.blocks ?? []);
    const fields: IntakeField[] = collectStepFields(step.blocks).map(field => ({ ...field, ...(labels.has(field.name) ? { option_labels: labels.get(field.name) } : {}) }));
    for (const field of fields) {
      if (names.has(field.name) || forbidden.has(field.name) || field.name.startsWith('_')) throw new IntakeError(`Invalid or repeated field ${field.name}`);
      if (!['text', 'textarea', 'email', 'tel', 'url', 'number', 'boolean', 'select', 'radio', 'checkbox', 'date'].includes(field.type)) throw new IntakeError(`Unsupported intake field ${field.name}`);
      if (field.type === 'checkbox' && !field.options?.length) throw new IntakeError(`Use a boolean or an explicit checkbox list for ${field.name}`);
      names.add(field.name);
    }
    return { id: step.id, title: step.title ?? step.id, fields, ...(when ? { when } : {}) };
  });
  if (names.size > 100 || Object.keys(conditions).some(key => !steps.some(step => step.id === key))) throw new IntakeError('Invalid intake conditions or too many fields');
  // Actions have their own operational guarantees. This contract only collects
  // private answers; it never silently runs email/content mutations on proposals.
  if (form.actions?.length) throw new IntakeError('Intake forms collect private answers; remove actions from this form');
  const result = { steps, context, reference };
  return JSON.parse(JSON.stringify({ ...result, revision: hash(result) }));
}
export function visibleIntake(snapshot: IntakeSnapshot, input: Record<string, unknown>, complete: boolean) {
  const data: Record<string, unknown> = {}, steps: IntakeStep[] = [];
  const known = new Set(snapshot.steps.flatMap(step => step.fields.map(field => field.name)));
  if (Object.keys(input).some(key => !known.has(key))) throw new IntakeError('The answer contains an unknown field');
  for (const step of snapshot.steps) {
    if (step.when) {
      const rule = step.when;
      const source = rule.source === 'context' ? snapshot.context : data;
      const value = Object.hasOwn(source, rule.field) ? source[rule.field] : undefined;
      if (Object.hasOwn(rule, 'equals') ? value !== rule.equals : !Array.isArray(value) || !value.includes(rule.includes)) continue;
    }
    steps.push(step);
    for (const field of step.fields) {
      if (!Object.hasOwn(input, field.name)) continue;
      const value = input[field.name];
      if (value === null) { data[field.name] = null; continue; }
      const valid = field.type === 'boolean' ? typeof value === 'boolean' : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : field.type === 'checkbox' ? Array.isArray(value) && value.every(item => typeof item === 'string' && (!field.options || field.options.includes(item)))
        : typeof value === 'string' && value.length <= 10_000 && (!field.options || !value || field.options.includes(value));
      if (!valid) throw new IntakeError(`Invalid answer for ${field.label}`);
      data[field.name] = value;
    }
  }
  if (complete) {
    const fields = steps.flatMap(step => step.fields);
    const errors = validateFieldValues(fields, data);
    for (const field of fields) if (field.required && Array.isArray(data[field.name]) && !(data[field.name] as unknown[]).length) errors.push({ field: field.name, code: 'required' });
    if (errors.length) throw new IntakeError(errors.map(error => `${fields.find(field => field.name === error.field)?.label}: ${defaultErrorMessage(error.code, fields.find(field => field.name === error.field)?.label ?? error.field, 'en')}`).join('; '), 422);
  }
  return { steps: steps.map(({ when: _when, ...step }) => step), data };
}
export async function extensionIntake(store: ReadWriteStore, org: string, site: string, installation: string, formId: string, input: Record<string, unknown>) {
  if (!['describe', 'complete'].includes(String(input.action)) || typeof input.subject_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.subject_id)) throw new IntakeError('Invalid intake identity or action');
  const form = await store.getDoc<Form>(`${paths.forms(org, site)}/${formId}`);
  if (!form || form.target?.installation_id !== installation) throw new IntakeError('Form not found', 404);
  const context = record(input.context ?? {}, 'context'), conditions = record(input.conditions ?? {}, 'conditions');
  const reference = record(input.reference ?? {}, 'reference') as Record<string, string>;
  if (Object.values(reference).some(value => typeof value !== 'string' || value.length > 200)) throw new IntakeError('Invalid reference');
  const answers = record(input.answers ?? {}, 'answers');
  const inputDigest = hash({ context, conditions, reference });
  const id = hash({ installation, formId, subject: input.subject_id });
  const path = `${paths.submissions(org, site)}/${id}`;
  let saved = await store.getDoc<IntakeRecord>(path);
  if (!saved) {
    if (input.action !== 'describe') throw new IntakeError('Start the questionnaire before submitting', 409);
    const snapshot = intakeSnapshot(form, context, conditions, reference);
    const now = new Date().toISOString();
    await store.createDocIfMissing(path, { form_id: formId, installation_id: installation, data: {}, status: 'partial', intake: snapshot, input_digest: inputDigest,
      created_at: now, updated_at: now, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    saved = await store.getDoc<IntakeRecord>(path);
  }
  if (!saved || saved.installation_id !== installation || saved.input_digest !== inputDigest) throw new IntakeError('The intake context changed. Start a new questionnaire.', 409);
  const revision = saved.intake.revision;
  if (input.action === 'complete' && input.revision !== revision) throw new IntakeError('Reload the questionnaire before submitting', 409);
  // Finish against the pinned questions, never silently change a respondent's
  // form midway. A new invitation takes a new snapshot of the current form.
  const visible = visibleIntake(saved.intake, answers, input.action === 'complete');
  if (input.action === 'complete') {
    const updated = await store.compareAndUpdateDoc<IntakeRecord>(path, current => current.status === 'partial' && current.intake.revision === revision,
      { data: visible.data, status: 'complete', updated_at: new Date().toISOString(), expires_at: null });
    if (!updated) {
      const current = await store.getDoc<IntakeRecord>(path);
      if (current?.status !== 'complete' || hash(current.data) !== hash(visible.data)) throw new IntakeError('This questionnaire was already submitted with different answers', 409);
    }
    return { ok: true, done: true, submission_id: id };
  }
  return { ok: true, done: saved.status === 'complete', revision, steps: visible.steps, answers: visible.data };
}
