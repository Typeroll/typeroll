import { describe, it, expect } from 'vitest';
import { checkCustomCss, styleElementText } from '../index.js';

const codes = (css: string) => checkCustomCss(css).map(p => `${p.severity}:${p.code}:${p.line}`);

describe('checkCustomCss', () => {
  it('accepts ordinary CSS, media queries and nesting', () => {
    expect(checkCustomCss('.s-eyebrow { color: red; }\n@media (min-width: 768px) {\n  .hero-title { font-size: 3rem }\n}\n.card { &:hover { color: blue } }\n/* note */ a[href^="https:"] { content: "}" }')).toEqual([]);
    expect(checkCustomCss('@font-face { font-family: X; src: url("x.woff2") }\n@charset "utf-8";')).toEqual([]);
  });

  it('reports syntax errors with lines', () => {
    expect(codes('.a { color: red;\n.b { }')).toEqual(['error:syntax:1']);
    expect(codes('.a { }\n}')).toEqual(['error:syntax:2']);
    expect(codes('.a { }\n/* open')).toEqual(['error:syntax:2']);
    expect(codes('.a { content: "x }')).toContain('error:syntax:1');
    expect(codes('color: red;')).toEqual(['error:syntax:1']);
    expect(codes('.a { }\n.b')).toEqual(['error:syntax:2']);
  });

  it('refuses constructs that can run script or end the stylesheet', () => {
    expect(codes('.a { background: url(javascript:alert(1)) }')).toContain('error:unsafe:1');
    expect(codes('.a { width: expression(alert(1)) }')).toContain('error:unsafe:1');
    expect(codes('.a { }</style><script>alert(1)</script>')).toContain('error:unsafe:1');
  });

  it('warns about selectors that target platform markup and @import', () => {
    const problems = checkCustomCss('@import url("x.css");\n.hero .block-heading-text { color: red }\n@media (min-width: 1px) { [data-block="prose"] p { margin: 0 } }\n.fine { color: red }');
    expect(problems.map(p => `${p.code}:${p.line}`)).toEqual(['import:1', 'platform_selector:2', 'platform_selector:3']);
    expect(problems[1].message).toContain('named style');
  });
});

describe('styleElementText', () => {
  it('cannot close the style element', () => {
    expect(styleElementText('a{}</style><script>x</script></STYLE>')).toBe('a{}<\\/style><script>x</script><\\/STYLE>');
  });
});
