import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  renderAllValues,
  resolveRecipients,
  buildEmailMessage,
  emailFieldsFromForm,
} from '../../lib/email/render-email';
import type { EmailActionConfig, EmailConnector, FormStep } from '@typeroll/shared';

const connector: EmailConnector = { type: 'smtp', from: 'Site <no-reply@site.com>', config: {} };

describe('email render', () => {
  it('escapes {{field}} and leaves {{{field}}} raw in HTML mode', () => {
    const data = { name: '<b>Al</b>', bio: '<i>hi</i>' };
    const out = renderTemplate('Hi {{name}} — {{{bio}}}', data, true);
    expect(out).toBe('Hi &lt;b&gt;Al&lt;/b&gt; — <i>hi</i>');
  });

  it('emits raw values in text mode (no escaping)', () => {
    const out = renderTemplate('Hi {{name}}', { name: '<b>Al</b>' }, false);
    expect(out).toBe('Hi <b>Al</b>');
  });

  it('joins array values', () => {
    expect(renderTemplate('{{tags}}', { tags: ['a', 'b'] }, true)).toBe('a, b');
  });

  it('renders an escaped HTML table for include_all', () => {
    const html = renderAllValues({ email: 'a@b.com', note: '<x>' }, 'html');
    expect(html).toContain('email');
    expect(html).toContain('a@b.com');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('renders a plain-text list for include_all', () => {
    expect(renderAllValues({ a: '1', b: '2' }, 'text')).toBe('a: 1\nb: 2');
  });

  it('resolves and validates templated recipients', () => {
    expect(resolveRecipients('{{email}}', { email: 'user@x.com' })).toBe('user@x.com');
    expect(resolveRecipients('{{email}}', { email: 'not-an-email' })).toBeNull();
    expect(resolveRecipients('a@x.com, bad, b@y.com', {})).toBe('a@x.com, b@y.com');
  });

  it('builds an autoresponder message to the submitter', () => {
    const action: EmailActionConfig = {
      to: '{{email}}',
      subject: 'Thanks {{name}}',
      body: '<p>Hi {{name}}</p>',
    };
    const { message, error } = buildEmailMessage(
      action,
      { email: 'user@x.com', name: 'Al' },
      connector,
    );
    expect(error).toBeUndefined();
    expect(message!.to).toBe('user@x.com');
    expect(message!.subject).toBe('Thanks Al');
    expect(message!.html).toBe('<p>Hi Al</p>');
    expect(message!.from).toBe('Site <no-reply@site.com>');
  });

  it('appends all values for an admin notification', () => {
    const action: EmailActionConfig = {
      to: 'admin@site.com',
      subject: 'New submission',
      body: '<p>New one:</p>',
      include_all: true,
    };
    const { message } = buildEmailMessage(action, { email: 'u@x.com', msg: 'hello' }, connector);
    expect(message!.html).toContain('<hr>');
    expect(message!.html).toContain('hello');
  });

  it('returns an error when recipient cannot be resolved', () => {
    const action: EmailActionConfig = { to: '{{email}}', subject: 's', body: 'b' };
    const { message, error } = buildEmailMessage(action, { email: '' }, connector);
    expect(message).toBeUndefined();
    expect(error).toMatch(/no valid recipient/);
  });

  it('strips newlines from the subject', () => {
    const action: EmailActionConfig = { to: 'a@b.com', subject: 'Line1\nLine2', body: 'b' };
    const { message } = buildEmailMessage(action, {}, connector);
    expect(message!.subject).toBe('Line1 Line2');
  });
});

describe('email render: labelled include_all listing', () => {
  const steps: FormStep[] = [
    {
      id: 'about',
      blocks: [
        { id: 'utm', type: 'form/hidden', data: { name: 'utm_source', value: '' } },
        { id: 'name', type: 'form/text', data: { name: 'name', label: 'Ditt namn' } },
        {
          id: 'grid',
          type: 'core/columns',
          data: {},
          slots: [[
            {
              id: 'ai',
              type: 'form/radio_group',
              data: {
                name: 'ai_status',
                label: 'Var står ni med AI i dag?',
                choices: [
                  { value: 'none', label: 'Inte börjat' },
                  { value: 'pilot', label: 'Pilot pågår' },
                  { value: 'same', label: 'same' },
                ],
              },
            },
          ]],
        },
      ],
    },
    {
      id: 'details',
      blocks: [
        {
          id: 'box',
          type: 'core/container',
          data: {},
          children: [
            {
              id: 'topics',
              type: 'form/checkbox_group',
              data: { name: 'topics', label: 'Ämnen', choices: [{ value: 'seo', label: 'Sök & SEO' }, { value: 'ads', label: 'Annonser' }] },
            },
            { id: 'msg', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } },
            { id: 'ref', type: 'form/hidden', data: { name: 'ref', value: '' } },
            { id: 'nolabel', type: 'form/text', data: { name: 'company', label: '' } },
            { id: 'consent', type: 'form/consent', data: { name: 'consent', text: '<p>Jag godkänner <a href="/p">villkoren</a> &amp; policyn</p>' } },
          ],
        },
      ],
    },
  ];
  const fields = emailFieldsFromForm({ steps });

  it('derives fields in form order, including nested containers and slots', () => {
    expect(fields.map((f) => f.name)).toEqual(['utm_source', 'name', 'ai_status', 'topics', 'message', 'ref', 'company', 'consent']);
    expect(fields.find((f) => f.name === 'utm_source')!.hidden).toBe(true);
    expect(fields.find((f) => f.name === 'company')!.label).toBeUndefined();
    expect(fields.find((f) => f.name === 'consent')!.label).toBe('Jag godkänner villkoren & policyn');
  });

  it('uses labels as headers, in form order, with undeclared keys last', () => {
    const data = { extra: 'x', message: 'hi', name: 'Al', company: 'Acme', ai_status: 'pilot' };
    expect(renderAllValues(data, 'text', fields)).toBe(
      'Ditt namn: Al\nVar står ni med AI i dag?: Pilot pågår\nMeddelande: hi\ncompany: Acme\nextra: x',
    );
  });

  it('shows choice labels for single and multiple choices', () => {
    expect(renderAllValues({ ai_status: 'same', topics: ['seo', 'ads', 'other'] }, 'text', fields)).toBe(
      'Var står ni med AI i dag?: same\nÄmnen: Sök & SEO, Annonser, other',
    );
    expect(renderAllValues({ topics: 'ads' }, 'text', fields)).toBe('Ämnen: Annonser');
  });

  it('omits empty hidden fields and keeps non-empty ones under their name', () => {
    const data = { utm_source: '', ref: 'newsletter', name: 'Al', message: '' };
    expect(renderAllValues(data, 'text', fields)).toBe('Ditt namn: Al\nMeddelande: \nref: newsletter');
    const labelled = emailFieldsFromForm({
      steps: [{ id: 's', blocks: [{ id: 'h', type: 'form/hidden', data: { name: 'utm_source', label: 'Kampanjkälla', value: '' } }] }],
    });
    expect(renderAllValues({ utm_source: 'linkedin' }, 'text', labelled)).toBe('Kampanjkälla: linkedin');
    expect(renderAllValues({ utm_source: '  ' }, 'text', labelled)).toBe('');
  });

  it('escapes labels and values and preserves textarea line breaks in HTML', () => {
    const escFields = emailFieldsFromForm({
      steps: [{ id: 's', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Fråga <b>här</b>' } }] }],
    });
    const html = renderAllValues({ message: 'rad 1\n<script>x</script>' }, 'html', escFields);
    expect(html).toContain('Fråga &lt;b&gt;här&lt;/b&gt;');
    expect(html).toContain('rad 1\n&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).not.toContain('>message<');
  });

  it('labels the include_all listing in built messages, in both formats', () => {
    const action: EmailActionConfig = { to: 'admin@site.com', subject: 'New', body: 'New lead', include_all: true, format: 'text' };
    const data = { name: 'Al', utm_source: '', ai_status: 'none' };
    const { message } = buildEmailMessage(action, data, connector, fields);
    expect(message!.text).toBe('New lead\n\nDitt namn: Al\nVar står ni med AI i dag?: Inte börjat');
    const { message: html } = buildEmailMessage({ ...action, format: 'html' }, data, connector, fields);
    expect(html!.html).toContain('<th align="left" style="padding:4px 12px 4px 0;vertical-align:top">Ditt namn</th>');
    expect(html!.html).not.toContain('utm_source');
  });

  it('keeps raw names in submission order without a form definition', () => {
    const data = { utm_source: '', b: '2', a: '1' };
    expect(renderAllValues(data, 'text')).toBe('utm_source: \nb: 2\na: 1');
    expect(buildEmailMessage({ to: 'a@b.com', subject: 's', body: 'b', include_all: true, format: 'text' }, data, connector).message!.text)
      .toBe('b\n\nutm_source: \nb: 2\na: 1');
  });

  it('lists only declared names once when a field repeats across steps', () => {
    const repeated = emailFieldsFromForm({
      steps: [
        { id: 'a', blocks: [{ id: 'e1', type: 'form/email', data: { name: 'email', label: 'E-post' } }] },
        { id: 'b', blocks: [{ id: 'e2', type: 'form/email', data: { name: 'email', label: 'Bekräfta' } }] },
      ],
    });
    expect(repeated).toHaveLength(1);
    expect(renderAllValues({ email: 'a@b.se' }, 'text', repeated)).toBe('E-post: a@b.se');
  });
});
