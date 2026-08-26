import { describe, it, expect } from 'vitest';
import { expandExtensionIncludes, expandFormIncludes, expandIncludes } from '../global-blocks.js';
import type { Partial as PartialDoc } from '../types.js';

function block(id: string, html: string, status: 'draft' | 'published' = 'published'): PartialDoc {
  return {
    id,
    name: id,
    kind: 'free',
    content_mode: 'html',
    status,
    html_content: html,
  } as PartialDoc;
}

describe('expandIncludes', () => {
  it('replaces <x-include name="X" /> with the published block body', () => {
    const out = expandIncludes(
      'before <x-include name="cta" /> after',
      [block('cta', '<p>JOIN</p>')],
    );
    expect(out).toContain('<p>JOIN</p>');
    expect(out).not.toContain('<x-include');
  });

  it('skips draft blocks (renders as empty)', () => {
    const out = expandIncludes(
      'a<x-include name="cta" />b',
      [block('cta', '<p>JOIN</p>', 'draft')],
    );
    expect(out).not.toContain('JOIN');
  });

  it('leaves unknown blocks as empty rather than the literal tag', () => {
    const out = expandIncludes('a<x-include name="missing" />b', []);
    expect(out).not.toContain('<x-include');
  });

  it('handles multiple includes', () => {
    const out = expandIncludes(
      '<x-include name="a" />|<x-include name="b" />',
      [block('a', 'AAA'), block('b', 'BBB')],
    );
    expect(out).toBe('AAA|BBB');
  });
});

describe('expandFormIncludes', () => {
  it('replaces self-closing and paired form directives through the shared form resolver', () => {
    const seen: string[] = [];
    const out = expandFormIncludes(
      'A<x-form id="newsletter" />B<x-form id="contact"></x-form>C',
      (formId) => {
        seen.push(formId);
        return `<form data-rendered="${formId}"></form>`;
      },
    );

    expect(seen).toEqual(['newsletter', 'contact']);
    expect(out).toBe(
      'A<form data-rendered="newsletter"></form>B<form data-rendered="contact"></form>C',
    );
  });

  it('renders an inert diagnostic comment for an unknown form id', () => {
    const out = expandFormIncludes('<x-form id="missing" />', () => undefined);
    expect(out).toContain('unknown form_id missing');
    expect(out).not.toContain('<x-form');
  });
});

describe('expandExtensionIncludes', () => {
  it('turns an installed block reference into an inert runtime mount', () => {
    const html = expandExtensionIncludes(
      `<x-extension block="extension--install-1--portal" props='{&quot;heading&quot;:&quot;My quote&quot;}' />`,
      (id) => id === 'extension--install-1--portal' ? {
        extension_id: 'se.vendor.quotes',
        installation_id: 'install-1',
        component_id: 'portal',
        label: 'Quote portal',
      } : undefined,
    );
    expect(html).toContain('data-tr-extension-installation="install-1"');
    expect(html).toContain('data-tr-extension-component="portal"');
    expect(html).toContain('data-block-data="{&quot;heading&quot;:&quot;My quote&quot;}"');
    expect(html).not.toContain('customer_token');
  });

  it('fails inertly for unknown blocks and invalid props', () => {
    expect(expandExtensionIncludes('<x-extension block="missing" />', () => undefined))
      .toBe('<!-- x-extension: unknown block missing -->');
    expect(expandExtensionIncludes('<x-extension block="known" props="nope" />', () => ({
      extension_id: 'se.vendor.app', installation_id: 'install', component_id: 'app',
    }))).toBe('<!-- x-extension: invalid props -->');
  });
});
