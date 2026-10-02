import { describe, expect, it } from 'vitest';
import { scopeBlockCss } from '../block-css-scope.js';

describe('scopeBlockCss', () => {
  it('prefixes every selector and maps :scope to the block itself', () => {
    const { css, rejected } = scopeBlockCss(':scope { gap: 1rem }\n.a, .b > c:not(.x, .y) { color: red }', 'icon_list');
    expect(css).toContain('[data-block="icon_list"]{ gap: 1rem }');
    expect(css).toContain('[data-block="icon_list"] .a,[data-block="icon_list"] .b > c:not(.x, .y){ color: red }');
    expect(rejected).toEqual([]);
  });

  it('scopes inside group rules and leaves keyframes alone', () => {
    const { css } = scopeBlockCss('@media (min-width: 40rem) { .a { x: 1 } }\n@keyframes spin { from { a: 1 } to { a: 2 } }', 'b');
    expect(css).toContain('@media (min-width: 40rem){ [data-block="b"] .a{ x: 1 } }');
    expect(css).toContain('@keyframes spin{ from { a: 1 } to { a: 2 } }');
  });

  it('reports document-wide selectors instead of shipping them', () => {
    const { css, rejected } = scopeBlockCss('body { margin: 0 } html, .ok { a: 1 }', 'b');
    expect(rejected).toEqual(['body', 'html']);
    expect(css).not.toContain('body');
    expect(css).toContain('[data-block="b"] .ok{ a: 1 }');
  });

  it('keeps comments and strings with braces intact', () => {
    const { css } = scopeBlockCss('/* { not a rule } */ .a::after { content: "}" }', 'b');
    expect(css).toContain('/* { not a rule } */');
    expect(css).toContain('[data-block="b"] .a::after{ content: "}" }');
  });
});
