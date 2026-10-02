import { describe, it, expect } from 'vitest';
import { collectStepFields, validateFieldValues, getStep, nextStep, normalizeFormAnswers, isCheckboxGroupField } from '../form-fields.js';
import type { Block, Form } from '../types.js';

const blocks: Block[] = [
  { id: 'g', type: 'core/grid', data: { cols: 2 }, children: [
    { id: 'a', type: 'form/text', data: { name: 'foretag', label: 'Företag', required: true, max: 80 } },
    { id: 'b', type: 'form/email', data: { name: 'epost', label: 'E-post', required: true } },
  ]},
  { id: 'c', type: 'core/prose', data: { html: '<p>mellantext</p>' } },
  { id: 'd', type: 'form/consent', data: { name: 'gdpr', text: '<p>ok</p>' } },
];

describe('collectStepFields', () => {
  it('derives fields from form/* blocks through containers; content blocks ignored', () => {
    const fields = collectStepFields(blocks);
    expect(fields.map((f) => f.name)).toEqual(['foretag', 'epost', 'gdpr']);
    expect(fields[1].type).toBe('email');
    expect(fields[2].required).toBe(true); // consent always required
  });

  it('preserves simple-editor field types, placeholders, and choices', () => {
    const fields = collectStepFields([
      { id: 'p', type: 'form/phone', data: { name: 'phone', label: 'Phone', placeholder: '+46' } },
      { id: 's', type: 'form/select', data: { name: 'topic', label: 'Topic', choices: [{ value: 'news', label: 'News' }] } },
    ]);
    expect(fields).toEqual([
      expect.objectContaining({ name: 'phone', type: 'tel', placeholder: '+46' }),
      expect.objectContaining({ name: 'topic', type: 'select', options: ['news'] }),
    ]);
  });
});

describe('validateFieldValues', () => {
  const fields = collectStepFields(blocks);
  it('flags missing requireds + bad email with codes', () => {
    const errors = validateFieldValues(fields, { epost: 'inte-en-mejl' });
    expect(errors).toContainEqual({ field: 'foretag', code: 'required' });
    expect(errors).toContainEqual({ field: 'epost', code: 'invalid_email' });
    expect(errors).toContainEqual({ field: 'gdpr', code: 'required' });
  });
  it('passes a valid submission', () => {
    expect(validateFieldValues(fields, { foretag: 'AB', epost: 'a@b.se', gdpr: 'yes' })).toEqual([]);
  });
  it('author-broken regex never blocks visitors', () => {
    const errs = validateFieldValues([{ name: 'x', type: 'text', label: 'X', pattern: '([' }], { x: 'anything' });
    expect(errs).toEqual([]);
  });
});

describe('normalizeFormAnswers', () => {
  const fields = collectStepFields([
    { id: 'g', type: 'form/checkbox_group', data: { name: 'interests', label: 'Interests', required: true, choices: [{ value: 'seo', label: 'SEO' }, { value: 'ads', label: 'Ads' }] } },
    { id: 't', type: 'form/toggle', data: { name: 'newsletter', label: 'Newsletter' } },
    { id: 'n', type: 'form/text', data: { name: 'name', label: 'Name' } },
  ]);

  it('tells a checkbox group from a single toggle', () => {
    expect(fields.map(isCheckboxGroupField)).toEqual([true, false, false]);
  });

  it('keeps every ticked value of a checkbox group as a list', () => {
    expect(normalizeFormAnswers(fields, { interests: ['seo', 'ads'] }).interests).toEqual(['seo', 'ads']);
  });

  it('turns one ticked box posted as a single string into a list', () => {
    expect(normalizeFormAnswers(fields, { interests: 'seo' }).interests).toEqual(['seo']);
  });

  it('answers an empty list when no box is ticked, so required still fails', () => {
    for (const input of [{}, { interests: '' }, { interests: [] }]) {
      const out = normalizeFormAnswers(fields, input);
      expect(out.interests).toEqual([]);
      expect(validateFieldValues(fields, out)).toEqual([{ field: 'interests', code: 'required' }]);
    }
  });

  it('keeps single values for other fields; a repeated key resolves to the last value', () => {
    const out = normalizeFormAnswers(fields, { interests: 'seo', newsletter: 'on', name: ['A', 'B'] });
    expect(out).toEqual({ interests: ['seo'], newsletter: 'on', name: 'B' });
    expect(normalizeFormAnswers(fields, { interests: 'seo' })).not.toHaveProperty('name');
  });
});

describe('step navigation', () => {
  const form = {
    id: 'f', name: 'F', fields: [], actions: [], created_at: '',
    steps: [
      { id: 's1' }, { id: 's2', next: 's4' }, { id: 's3' }, { id: 's4' },
    ],
  } as unknown as Form;
  it('defaults to list order, honours next overrides, ends with undefined', () => {
    expect(getStep(form, undefined)?.id).toBe('s1');
    expect(nextStep(form, form.steps![0])?.id).toBe('s2');
    expect(nextStep(form, form.steps![1])?.id).toBe('s4'); // hoppar s3
    expect(nextStep(form, form.steps![3])).toBeUndefined();
  });
});
