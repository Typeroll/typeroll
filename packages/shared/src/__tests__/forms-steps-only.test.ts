// Steps are the ONLY stored form model. A flat fields[] list is authoring
// sugar the WRITE APIs convert via fieldsToSteps; the renderer only knows
// steps. These tests pin the conversion table and the renderer contract.

import { describe, it, expect } from 'vitest';
import { fieldsToStepBlocks, fieldsToSteps } from '../form-fields.js';
import { FORM_SHELL_CSS, renderFormHtml } from '../render-form.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Form, FormField } from '../types.js';

const registry = buildCoreBlockRegistry();
const embed = { submit_url: '/api/forms/submit?x=1', submit_token: 'tok-123' };

function form(overrides: Partial<Form>): Form {
  return {
    id: 'kontakt',
    name: 'Kontakt',
    actions: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('fieldsToStepBlocks — sugar conversion table', () => {
  it('maps every field type to its canonical form/* block', () => {
    const fields: FormField[] = [
      { name: 'a', type: 'text', label: 'A' },
      { name: 'b', type: 'email', label: 'B' },
      { name: 'c', type: 'tel', label: 'C' },
      { name: 'd', type: 'url', label: 'D' },
      { name: 'e', type: 'number', label: 'E', min: 1, max: 9 },
      { name: 'f', type: 'textarea', label: 'F' },
      { name: 'g', type: 'select', label: 'G', options: ['x', 'y'] },
      { name: 'h', type: 'radio', label: 'H', options: ['x'] },
      { name: 'i', type: 'checkbox', label: 'I', options: ['x', 'y'] },
      { name: 'j', type: 'checkbox', label: 'J' },
      { name: 'k', type: 'hidden', label: 'K', default: 'v1' },
      { name: 'l', type: 'gdpr_consent', label: 'I agree' },
      { name: 'm', type: 'whatever-unknown', label: 'M' },
    ];
    const types = fieldsToStepBlocks(fields).map((b) => b.type);
    expect(types).toEqual([
      'form/text', 'form/email', 'form/phone', 'form/url', 'form/number',
      'form/textarea', 'form/select', 'form/radio_group',
      'form/checkbox_group', 'form/toggle', 'form/hidden', 'form/consent',
      'form/text',
    ]);
  });

  it('carries required/placeholder, converts options to choices, keeps numeric bounds', () => {
    const [sel, num, hid, consent] = fieldsToStepBlocks([
      { name: 'plan', type: 'select', label: 'Plan', required: true, placeholder: 'Pick', options: ['s', 'm'] },
      { name: 'qty', type: 'number', label: 'Qty', min: 2, max: 10 },
      { name: 'src', type: 'hidden', label: '', default: 'campaign-7' },
      { name: 'gdpr', type: 'gdpr_consent', label: 'I accept the terms' },
    ]);
    expect(sel.data).toMatchObject({
      name: 'plan', label: 'Plan', required: true, placeholder: 'Pick',
      choices: [{ value: 's', label: 's' }, { value: 'm', label: 'm' }],
    });
    expect(num.data).toMatchObject({ min: 2, max: 10 });
    expect(hid.data).toMatchObject({ name: 'src', value: 'campaign-7' });
    expect(consent.data).toMatchObject({ name: 'gdpr', text: 'I accept the terms' });
  });

  it('fieldsToSteps wraps the blocks in one static step', () => {
    const steps = fieldsToSteps([{ name: 'email', type: 'email', label: 'E-post' }]);
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('main');
    expect(steps[0].blocks).toHaveLength(1);
  });
});

describe('renderFormHtml — steps-only contract', () => {
  it('ships transitive field styles even when a form contains no form/text block', () => {
    expect(FORM_SHELL_CSS).toContain('.form-field { display: flex; flex-direction: column');
    expect(FORM_SHELL_CSS).toContain('[data-block="form_textarea"] textarea');
    expect(FORM_SHELL_CSS).toContain('[data-block="form_radio_group"]');
    expect(FORM_SHELL_CSS).toContain('.form-input:focus-visible');
  });

  it('renders a converted simple form end-to-end (token, honeypot, fields)', () => {
    const html = renderFormHtml(
      form({
        steps: fieldsToSteps([
          { name: 'email', type: 'email', label: 'E-post', required: true },
          { name: 'message', type: 'textarea', label: 'Meddelande' },
        ]),
        success_message: 'Tack!',
      }),
      embed,
      { registry },
    );
    expect(html).toContain('name="_token" value="tok-123"');
    expect(html).toContain('name="_hp"');
    expect(html).toContain('data-form-step="main"');
    expect(html).toContain('type="email"');
    expect(html).toContain('name="message"');
    expect(html).toContain('<textarea');
  });

  it('a form without steps renders a comment, never a broken shell', () => {
    const html = renderFormHtml(form({}), embed, { registry });
    expect(html).toContain('has no steps');
    expect(html).not.toContain('<form');
  });
});
