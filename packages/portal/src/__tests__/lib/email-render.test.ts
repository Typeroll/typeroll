import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  renderAllValues,
  resolveRecipients,
  buildEmailMessage,
} from '../../lib/email/render-email';
import type { EmailActionConfig, EmailConnector } from '@typeroll/shared';

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
