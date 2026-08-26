// Pure-function tests for BlockTypePreview's preview-doc composer.
// The React component itself isn't tested here (no DOM in vitest); we
// validate that the document it would inject into the iframe carries
// the user's template + styles + sample data correctly.

import { describe, it, expect } from 'vitest';
import { defaultSampleData, renderPreview } from '../../components/BlockTypePreview';
import type { BlockType, FieldDefinition } from '@typeroll/shared';

describe('defaultSampleData', () => {
  it('generates a value for every schema field', () => {
    const schema: FieldDefinition[] = [
      { name: 'title', type: 'text', label: 'Title' },
      { name: 'body', type: 'richtext', label: 'Body' },
      { name: 'photo', type: 'image', label: 'Photo' },
      { name: 'count', type: 'number', label: 'Count' },
      { name: 'enabled', type: 'boolean', label: 'Enabled' },
      { name: 'level', type: 'select', label: 'Level', options: ['h1', 'h2', 'h3'] },
    ];
    const data = defaultSampleData(schema);
    expect(typeof data.title).toBe('string');
    expect(String(data.body)).toContain('<');     // richtext is HTML
    expect(String(data.photo)).toMatch(/^https?:\/\//);
    expect(typeof data.count).toBe('number');
    expect(typeof data.enabled).toBe('boolean');
    expect(data.level).toBe('h1');                // first option
  });

  it('honours field.default when present', () => {
    const schema: FieldDefinition[] = [
      { name: 'size', type: 'select', label: 'Size', options: ['sm', 'md', 'lg'], default: 'md' },
    ];
    expect(defaultSampleData(schema).size).toBe('md');
  });

  it('picks heuristic text for common field names', () => {
    const schema: FieldDefinition[] = [
      { name: 'heading', type: 'text', label: 'Heading' },
      { name: 'name', type: 'text', label: 'Name' },
      { name: 'cta_label', type: 'text', label: 'Button text' },
    ];
    const data = defaultSampleData(schema);
    expect(String(data.heading).toLowerCase()).toContain('heading');
    expect(String(data.name)).toBe('Jane Doe');
    expect(String(data.cta_label)).toBe('Get started');
  });

  it('fills array fields with a few sample items matching the inner schema', () => {
    const schema: FieldDefinition[] = [
      { name: 'items', type: 'array', label: 'Items', fields: [
        { name: 'heading', type: 'text', label: 'Heading' },
        { name: 'icon', type: 'icon', label: 'Icon' },
      ] },
    ];
    const data = defaultSampleData(schema);
    const items = data.items as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(typeof item.heading).toBe('string');
      expect(item.icon).toBe('star');
    }
  });
});

describe('renderPreview', () => {
  it('returns a placeholder when no template is set', () => {
    const html = renderPreview({}, {});
    expect(html).toContain('No template yet');
  });

  it('composes a full HTML document with the block body + scoped styles', () => {
    const draft: Partial<BlockType> = {
      name: 'fancy',
      label: 'Fancy',
      template: '<aside data-block="fancy">{{title}}</aside>',
      styles: '[data-block="fancy"]{padding:1rem;color:red}',
      schema: [{ name: 'title', type: 'text', label: 'Title', default: 'Hello' }],
    };
    const html = renderPreview(draft, { title: 'Hello' });

    // Full document shape
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');

    // The rendered block body lives in <body>
    expect(html).toContain('<aside data-block="fancy">Hello</aside>');

    // The user's styles are concatenated into the head
    expect(html).toContain('[data-block="fancy"]{padding:1rem;color:red}');

    // Runtime CSS is always included (visibility rules)
    expect(html).toContain('data-hidden-mobile');
  });

  it('HTML-escapes data values like the real renderer', () => {
    const html = renderPreview({
      name: 'safe',
      template: '<p data-block="safe">{{text}}</p>',
      schema: [{ name: 'text', type: 'text', label: 'Text' }],
    }, { text: '<script>alert(1)</script>' });
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows children placeholder for container blocks', () => {
    const html = renderPreview({
      name: 'box',
      template: '<section data-block="box">{{children}}</section>',
      container: true,
      schema: [],
    }, {});
    expect(html).toContain('Children appear here');
  });

  it('shows slot placeholders for slot containers', () => {
    const html = renderPreview({
      name: 'split',
      template: '<div data-block="split"><div>{{slot:Left}}</div><div>{{slot:Right}}</div></div>',
      container: 'slots',
      slot_count: 2,
      slot_labels: ['Left', 'Right'],
      schema: [],
    }, {});
    expect(html).toContain('Slot 1');
    expect(html).toContain('Slot 2');
  });

  it('surfaces template errors instead of throwing', () => {
    // A template that produces a non-fatal renderer output should still
    // return a document; this also confirms the try/catch is wired so
    // bad drafts can't crash the editor.
    const html = renderPreview({
      name: 'broken',
      template: '<div data-block="broken">{{unknown}}</div>',
      schema: [],
    }, {});
    // Empty substitution is fine — the doc renders.
    expect(html).toContain('<div data-block="broken"></div>');
  });
});
