// The builder's preview iframe document. Rendering itself happens on the
// server (blocks/types/preview, tested in blocks-types-crud.test.ts); the
// component wraps a fragment result in a plain shell.

import { describe, expect, it } from 'vitest';
import { previewDocument } from '../../components/BlockTypePreview';

describe('previewDocument', () => {
  it('wraps a fragment with its CSS', () => {
    const doc = previewDocument({ html: '<div data-block="note">Hi</div>', css: '[data-block="note"]{color:red}' });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<body><div data-block="note">Hi</div></body>');
    expect(doc).toContain('[data-block="note"]{color:red}');
  });

  it('keeps a stylesheet from closing the style element early', () => {
    const doc = previewDocument({ html: '', css: 'a{}</style><script>alert(1)</script>' });
    expect(doc).not.toContain('</style><script>');
  });

  it('uses the server document when there is one', () => {
    expect(previewDocument({ html: '<p>x</p>', css: '', document: '<!doctype html><html><body>Site theme</body></html>' })).toContain('Site theme');
  });

  it('passes a full document through', () => {
    const html = '<!doctype html><html><body>Full</body></html>';
    expect(previewDocument({ html, css: 'x' })).toBe(html);
  });
});
