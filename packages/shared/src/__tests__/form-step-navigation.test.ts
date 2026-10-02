// Multi-step form navigation: step visibility, per-step button labels, back
// navigation, step titles, step announcements and the progress indicator.
import { Window } from 'happy-dom';
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { FORM_SHELL_CSS, renderFormHtml } from '../render-form.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();

const LEAD: Form = {
  id: 'lead', name: 'Lead', actions: [], created_at: 'x', submit_text: 'Anmäl intresse',
  steps: [
    { id: 'contact', title: 'Kontakt', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'E-post', required: true } }] },
    { id: 'company', title: 'Företag', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Företag', required: true } }] },
    { id: 'message', title: 'Meddelande', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } }] },
  ],
};

const embed = { submit_url: 'https://forms.example/api/forms/submit', submit_token: 'tok' };

describe('hidden steps', () => {
  it('stay hidden when site CSS changes the display of steps', async () => {
    const window = new Window({ url: 'https://site.example/' });
    try {
      window.document.head.innerHTML = `<style>[data-form-step], [data-form-dynamic-step] { display: contents; }</style><style>${FORM_SHELL_CSS}</style>`;
      window.document.body.innerHTML = renderFormHtml(LEAD, embed, { registry });
      const display = (selector: string) => window.getComputedStyle(window.document.querySelector(selector)!).display;
      expect(display('[data-form-step="contact"]')).toBe('contents');
      expect(display('[data-form-step="company"]')).toBe('none');
      expect(display('[data-form-dynamic-step]')).toBe('none');
    } finally {
      await window.happyDOM.close();
    }
  });
});
