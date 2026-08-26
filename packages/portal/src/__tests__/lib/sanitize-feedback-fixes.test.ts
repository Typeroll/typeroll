// Regressions reported in MCP-FEEDBACK-2.md from the Sundsvallsflytt
// demo build. Each test pins one of the previously-silent strips.

import { describe, it, expect } from 'vitest';
import { sanitizeBody } from '../../lib/sanitize';
import { diffSanitizationDetails } from '../../lib/sanitize-warnings';

describe('sanitizeBody — <x-include> survives', () => {
  it('keeps self-closing form intact', () => {
    const html = '<p>before</p><x-include name="cta" /><p>after</p>';
    const out = sanitizeBody(html);
    expect(out).toContain('<x-include name="cta"');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('keeps long form intact', () => {
    const html = '<x-include name="trust-strip"></x-include>';
    const out = sanitizeBody(html);
    expect(out).toContain('<x-include');
    expect(out).toContain('name="trust-strip"');
  });

  it('strips unknown attrs but keeps name', () => {
    const html = '<x-include name="cta" onclick="x()" />';
    const out = sanitizeBody(html);
    expect(out).toContain('name="cta"');
    expect(out).not.toContain('onclick');
  });
});

describe('sanitizeBody — Schema.org microdata survives', () => {
  it('keeps itemscope/itemtype/itemprop on a section', () => {
    const html = `
      <section itemscope itemtype="https://schema.org/PostalAddress">
        <span itemprop="streetAddress">Storgatan 12</span>
        <span itemprop="postalCode">85230</span>
      </section>`;
    const out = sanitizeBody(html);
    expect(out).toContain('itemscope');
    expect(out).toContain('itemtype="https://schema.org/PostalAddress"');
    expect(out).toContain('itemprop="streetAddress"');
  });

  it('keeps microdata on common elements (span, div, address)', () => {
    const html =
      '<div itemscope itemtype="https://schema.org/MovingCompany">' +
      '<address itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">' +
      '<span itemprop="streetAddress">Storgatan 12</span></address></div>';
    const out = sanitizeBody(html);
    expect(out).toContain('itemtype="https://schema.org/MovingCompany"');
    expect(out).toContain('itemtype="https://schema.org/PostalAddress"');
  });
});

describe('diffSanitizationDetails — structured kinds', () => {
  it('emits kind="x-include" if a future regression strips it', () => {
    // Synthesize the before/after directly — simulates a hypothetical
    // sanitizer drop. The kind regex matches against the BEFORE only,
    // so this proves the warning structure works even though current
    // sanitizer doesn't drop it.
    const before = '<p>x</p><x-include name="cta" />';
    const after = '<p>x</p>';
    const diff = diffSanitizationDetails(before, after);
    const xi = diff.details.find((d) => d.kind === 'x-include');
    expect(xi).toBeTruthy();
    expect(xi!.count).toBe(1);
  });

  it('emits kind="microdata" if itemscope/itemprop get stripped', () => {
    const before = '<div itemscope itemtype="x"><span itemprop="y">z</span></div>';
    const after = '<div><span>z</span></div>';
    const diff = diffSanitizationDetails(before, after);
    const md = diff.details.find((d) => d.kind === 'microdata');
    expect(md).toBeTruthy();
    expect(md!.count).toBe(3); // itemscope + itemtype + itemprop
    expect(md!.label).toMatch(/json_ld/i);
  });

  it('still uses kind="unknown" for the catch-all bulk-strip fallback', () => {
    const before = 'a'.repeat(500);
    const after = '';
    const diff = diffSanitizationDetails(before, after);
    expect(diff.details.find((d) => d.kind === 'unknown')).toBeTruthy();
  });
});
