import { describe, it, expect } from 'vitest';
import { customCssWarnings, customCssWriteError } from '../../lib/custom-css-write';

describe('custom CSS writes', () => {
  it('accepts empty values and valid CSS', () => {
    for (const value of [undefined, null, '', '.s-lead { color: #111 }']) expect(customCssWriteError(value)).toBeNull();
  });

  it('refuses non-text, syntax errors and unsafe CSS with line numbers', () => {
    expect(customCssWriteError(42)).toBe('custom_css must be text');
    expect(customCssWriteError('.a {\n  color: red;\n')).toMatch(/line 1: A "\{" is not closed/);
    expect(customCssWriteError('.a{}</style><script>alert(1)</script>')).toMatch(/style/);
  });

  it('reports platform selectors as warnings, not errors', () => {
    const css = '[data-block="heading"] .block-heading-text { color: red }';
    expect(customCssWriteError(css)).toBeNull();
    expect(customCssWarnings(css)).toHaveLength(1);
  });
});
