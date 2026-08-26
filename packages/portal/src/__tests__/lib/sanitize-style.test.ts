// Tests for the post-feedback sanitizer changes:
//   - <style> blocks survive sanitization
//   - dangerous CSS constructs inside <style> get scrubbed
//   - sanitization_details surfaces the scrubbing as structured records

import { describe, it, expect } from 'vitest';
import { sanitizeBody } from '../../lib/sanitize';
import { diffSanitizationDetails } from '../../lib/sanitize-warnings';

describe('sanitizeBody — <style> tag handling', () => {
  it('keeps inline <style> blocks intact', () => {
    const input = '<style>.brand{color:#0b4a6f}.brand:hover{color:#1a8}</style><p class="brand">x</p>';
    const out = sanitizeBody(input);
    expect(out).toContain('<style>');
    expect(out).toContain('.brand');
    expect(out).toContain(':hover');
    expect(out).toContain('color:#0b4a6f');
  });

  it('keeps CSS variables, media queries, keyframes inside <style>', () => {
    const input = `<style>
      :root{--c:#0b4a6f}
      @media (max-width: 768px){.brand{font-size:.9rem}}
      @keyframes fade{from{opacity:0}to{opacity:1}}
    </style>`;
    const out = sanitizeBody(input);
    expect(out).toContain('--c:#0b4a6f');
    expect(out).toContain('@media');
    expect(out).toContain('@keyframes');
  });

  it('strips expression() out of style content', () => {
    const input = `<style>.evil{width:expression(alert(1))}</style>`;
    const out = sanitizeBody(input);
    // The exploit form (expression with a paren and arg) is gone — the
    // placeholder comment is harmless and intentionally human-readable.
    expect(out).not.toMatch(/expression\s*\(\s*alert/);
    expect(out).toContain('/* expression() stripped */');
  });

  it('strips behavior:url() out of style content', () => {
    const input = `<style>.evil{behavior:url(htc.htc)}</style>`;
    const out = sanitizeBody(input);
    expect(out).not.toMatch(/behavior\s*:\s*url\(/);
    expect(out).toContain('/* behavior:url stripped */');
  });

  it('strips @import out of style content', () => {
    const input = `<style>@import url('//evil.example/x.css');.x{}</style>`;
    const out = sanitizeBody(input);
    // The exploit (url() following @import) is gone — placeholder comment fine.
    expect(out).not.toMatch(/@import\s+url\(/);
    expect(out).not.toContain('evil.example');
    expect(out).toContain('/* @import stripped */');
  });

  it('strips url(javascript:) out of style content', () => {
    const input = `<style>.x{background:url(javascript:alert(1))}</style>`;
    const out = sanitizeBody(input);
    expect(out).not.toMatch(/url\(\s*['"]?javascript:/);
    expect(out).toContain('/* javascript: stripped */');
  });

  it('still strips <script> tags (regression check)', () => {
    const out = sanitizeBody('<style>.x{}</style><script>alert(1)</script>');
    expect(out).toContain('<style>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });
});

describe('diffSanitizationDetails — structured output', () => {
  it('reports <script> strip as a structured detail', () => {
    const before = '<p>hi</p><script>alert(1)</script>';
    const after = sanitizeBody(before);
    const diff = diffSanitizationDetails(before, after);
    expect(diff.details.some((d) => d.kind === 'script' && d.count === 1)).toBe(true);
    expect(diff.messages.length).toBeGreaterThan(0);
  });

  it('reports css-exploit when style scrubbing fired', () => {
    const before = '<style>.x{width:expression(alert(1))}</style>';
    const after = sanitizeBody(before);
    const diff = diffSanitizationDetails(before, after);
    expect(diff.details.some((d) => d.kind === 'css-exploit' && d.count >= 1)).toBe(true);
  });

  it('reports nothing when the input is already clean', () => {
    const before = '<style>.brand{color:red}</style><p class="brand">hi</p>';
    const after = sanitizeBody(before);
    const diff = diffSanitizationDetails(before, after);
    expect(diff.details).toEqual([]);
    expect(diff.messages).toEqual([]);
  });

  it('counts event handlers in structured form', () => {
    const before = '<p onclick="x()">a</p><a onmouseover="y()">b</a>';
    const after = sanitizeBody(before);
    const diff = diffSanitizationDetails(before, after);
    const handler = diff.details.find((d) => d.kind === 'event-handler');
    expect(handler).toBeTruthy();
    expect(handler!.count).toBe(2);
  });

  it('falls back to a structured unknown record for large unexplained shrinkage', () => {
    // Synthesize a before/after pair directly — the goal is to verify the
    // fallback path emits a structured 'unknown' record, not to find a
    // strip pattern sanitize-html happens to apply. Use the diff function
    // standalone so the test is hermetic.
    const before = 'a'.repeat(500);
    const after = '';
    const diff = diffSanitizationDetails(before, after);
    const unknown = diff.details.find((d) => d.kind === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown!.bytes).toBe(500);
  });
});
