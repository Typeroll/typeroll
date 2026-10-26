import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import { sanitizeSvg, sanitizeSvgCss, SvgSanitizeError } from '../../lib/media/svg-sanitize';

const SVG = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

/** Element names and attributes in document order, for comparing rendering structure. */
function structure(svg: string, keep: (name: string) => boolean = name => !name.includes(':')) {
  const nodes: string[] = [];
  let skip = 0;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (skip || !keep(name)) { skip++; return; }
      const attrs = Object.entries(attribs).filter(([key]) => !key.startsWith('xmlns') && !key.includes(':') || key.startsWith('xlink:') || key.startsWith('xml:'))
        .map(([key, value]) => `${key}=${value.trim()}`).sort();
      nodes.push(`${name}[${attrs.join(' ')}]`);
    },
    onclosetag() { if (skip) skip--; else nodes.push('/'); },
    ontext(text) {
      if (skip) return;
      if (nodes.at(-1)?.startsWith('#')) nodes[nodes.length - 1] += text; else nodes.push(`#${text}`);
    },
  }, { xmlMode: true });
  parser.write(svg.replace(/<!DOCTYPE[^\[>]*(\[[\s\S]*?\])?\s*>/, '').replace(/<!--[\s\S]*?-->/g, ''));
  parser.end();
  return nodes.map(node => node.startsWith('#') ? `#${node.slice(1).trim()}` : node).filter(node => node !== '#');
}

/** Nothing in the output may run script, load a remote resource or redefine markup. */
function expectInert(svg: string) {
  expect(svg).not.toMatch(/<script|<foreignObject|<iframe|<handler|<listener|<html|<body|<img/i);
  expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
  expect(svg).not.toMatch(/javascript:|vbscript:|@import|-moz-binding|behavior|expression\(/i);
  expect(svg).not.toMatch(/<!DOCTYPE|<!ENTITY|<\?/i);
  expect(svg).not.toMatch(/xml:base/);
  expect(svg).not.toMatch(/attributeName="(?:xlink:)?href"/i);
  for (const match of svg.matchAll(/\s(?:xlink:)?href="([^"]*)"/g)) {
    expect(match[1]).toMatch(/^#|^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/);
  }
  for (const match of svg.matchAll(/url\(\s*['"]?([^'")]*)/gi)) expect(match[1]).toMatch(/^#/);
  // Sanitizing again is a no-op: the output is already in its stored form.
  expect(sanitizeSvg(Buffer.from(svg)).svg).toBe(svg);
}

const attacks: Record<string, string> = {
  script: `<svg ${SVG}><script>alert(1)</script><script><![CDATA[alert(2)]]></script><rect width="1" height="1"/></svg>`,
  onload: `<svg ${SVG} onload="alert(1)" ONLOAD="alert(2)"><rect onclick="alert(3)" onmouseover = "alert(4)" width="1"/></svg>`,
  javascriptHref: `<svg ${SVG} ${XLINK}><a xlink:href="javascript:alert(1)"><text>x</text></a><a href="javascript:alert(2)"><rect width="1"/></a></svg>`,
  encodedJavascript: `<svg ${SVG}><a href="&#106;avascript:alert(1)">x</a><use href="java&#9;script:alert(2)"/><use href=" javascript:alert(3)#x"/></svg>`,
  foreignObject: `<svg ${SVG}><foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/><iframe src="javascript:alert(2)"/></body></foreignObject></svg>`,
  externalUse: `<svg ${SVG} ${XLINK}><use href="https://evil.example/sprite.svg#a"/><use xlink:href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+#a"/><use href="//evil.example/x.svg#b"/></svg>`,
  entities: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>"><!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${SVG}><text>&x;&xxe;</text></svg>`,
  xslt: `<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?><svg ${SVG}><rect width="1"/><?php echo 1 ?></svg>`,
  cssUrls: `<svg ${SVG}><style>@import url(https://evil.example/x.css);@import "https://evil.example/y.css";.a{fill:url(javascript:alert(1))}.b{fill:url( "https://evil.example/t.svg#p" )}.c{fill:url(#ok)}.d{background:image-set("https://evil.example/t.png" 1x)}.e{behavior:url(x.htc);-moz-binding:url(x.xml#b)}.f{width:expression(alert(1))}</style><rect class="c" width="1"/></svg>`,
  cssEscapes: `<svg ${SVG}><style>@\\69mport 'x.css';.a{fill:u\\72l(https://evil.example/)}</style><rect style="fill:u\\72l(https://evil.example/);stroke:red" width="1"/></svg>`,
  styleAttribute: `<svg ${SVG}><rect style="background:url(javascript:alert(1));fill:red" width="1"/><rect style="fill:url(https://evil.example/p.svg#x)" width="2"/></svg>`,
  animatedHref: `<svg ${SVG} ${XLINK}><a><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="xlink:href" to="javascript:alert(2)"/><set attributeName="onclick" to="alert(3)"/><animate attributeName="HREF" to="javascript:alert(4)"/><text>click</text></a></svg>`,
  namespaceTricks: `<svg xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script><html:script xmlns:html="http://www.w3.org/1999/xhtml">alert(2)</html:script><g xmlns="http://www.w3.org/1999/xhtml"><rect width="1"/></g></svg>`,
  xmlBase: `<svg ${SVG} xml:base="https://evil.example/"><use href="#a" xml:base="https://evil.example/"/></svg>`,
  externalImages: `<svg ${SVG}><image href="https://evil.example/track.png" width="1"/><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="1"/><filter id="f"><feImage href="https://evil.example/x.png"/></filter></svg>`,
  legacyHandlers: `<svg ${SVG}><handler type="application/ecmascript">alert(1)</handler><listener event="click" handler="#h"/><rect width="1"/></svg>`,
  styleWithMarkup: `<svg ${SVG}><style><![CDATA[</style><script>alert(1)</script>]]></style><style type="text/ecmascript">alert(2)</style></svg>`,
};

describe('sanitizeSvg attack payloads', () => {
  for (const [name, payload] of Object.entries(attacks)) {
    it(`makes ${name} inert`, () => {
      const result = sanitizeSvg(Buffer.from(payload));
      expectInert(result.svg);
      expect(result.svg.startsWith(`<svg ${SVG}`)).toBe(true);
      expect(result.removed.length).toBeGreaterThan(0);
    });
  }

  it('keeps entity references from a stripped DOCTYPE as text', () => {
    expect(sanitizeSvg(Buffer.from(attacks.entities)).svg).toBe(`<svg ${SVG}><text>&amp;x;&amp;xxe;</text></svg>`);
  });

  it('keeps fragment-only CSS and drops every other declaration', () => {
    const css = sanitizeSvgCss('.c{fill:url(#ok)}.b{fill:url(https://x/y)}.d{fill:url("#ok2")}');
    expect(css).toContain('fill:url(#ok)');
    expect(css).toContain('fill:url("#ok2")');
    expect(css).not.toContain('https://');
  });

  it('removes the link and its animation but keeps the drawing', () => {
    const { svg } = sanitizeSvg(Buffer.from(attacks.javascriptHref));
    expect(svg).toBe(`<svg ${SVG}><g><text>x</text></g><g><rect width="1"/></g></svg>`);
  });
});

describe('sanitizeSvg rejects input that is not a well-formed SVG', () => {
  const invalid: Record<string, string | Buffer> = {
    html: '<html><body><script>alert(1)</script></body></html>',
    xhtmlRoot: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
    unclosed: `<svg ${SVG}><g><rect width="1"/></svg>`,
    truncated: `<svg ${SVG}><path d="M0 0`,
    trailingContent: `<svg ${SVG}></svg><script>alert(1)</script>`,
    innerDeclaration: `<svg ${SVG}><!ENTITY x "y"><rect/></svg>`,
    duplicateAttribute: `<svg ${SVG}><a href="#a" href="javascript:alert(1)">x</a></svg>`,
    text: 'not an image',
    gzip: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    invalidUtf8: Buffer.concat([Buffer.from(`<svg ${SVG}><text>`), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('</text></svg>')]),
    unterminatedDoctype: `<!DOCTYPE svg [<!ENTITY a "b"> <svg ${SVG}/>`,
  };
  for (const [name, payload] of Object.entries(invalid)) {
    it(`rejects ${name}`, () => {
      expect(() => sanitizeSvg(typeof payload === 'string' ? Buffer.from(payload) : payload)).toThrow(SvgSanitizeError);
    });
  }

  it('reports an input that ends early as truncated, a broken structure as invalid', () => {
    const kind = (input: string) => { try { sanitizeSvg(Buffer.from(input)); } catch (error) { return (error as SvgSanitizeError).kind; } };
    expect(kind(invalid.truncated as string)).toBe('truncated');
    expect(kind(`<svg ${SVG}><g><rect/>`)).toBe('truncated');
    expect(kind(invalid.unclosed as string)).toBe('invalid');
    expect(kind(invalid.html as string)).toBe('invalid');
  });
});

const logo = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_flows "http://ns.adobe.com/Flows/1.0/">
]>
<svg version="1.1" id="Layer_1" ${SVG} ${XLINK} x="0px" y="0px" viewBox="0 0 240 80" preserveAspectRatio="xMidYMid meet" style="enable-background:new 0 0 240 80;" xml:space="preserve">
  <title>Acme logo</title>
  <defs>
    <linearGradient id="grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="240" y2="80" gradientTransform="rotate(10)">
      <stop offset="0" style="stop-color:#FF7A00"/>
      <stop offset="1" stop-color="#C2185B" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="grad2" xlink:href="#grad" spreadMethod="reflect"/>
    <radialGradient id="glow" cx="40" cy="40" r="30" fx="35" fy="35" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="clip" clipPathUnits="userSpaceOnUse"><rect width="240" height="80" rx="12"/></clipPath>
  </defs>
  <g clip-path="url(#clip)" fill-rule="evenodd">
    <path fill="url(#grad)" d="M10 70 L40 10 L70 70 Z"/>
    <circle cx="40" cy="40" r="30" fill="url('#glow')"/>
    <text x="90" y="52" font-family="'Helvetica Neue', Arial, sans-serif" font-size="32" font-weight="700" fill="url(#grad2)" letter-spacing="-0.5">Acme &amp; Co</text>
  </g>
</svg>
`;

const iconSet = `<svg ${SVG} ${XLINK} width="0" height="0" style="display:none">
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-star" viewBox="0 0 24 24"><polygon points="12 2 15 9 22 9 16 14 18 21 12 17 6 21 8 14 2 9 9 9"/></symbol>
  <use href="#icon-check" x="0" y="0" width="24" height="24"/>
  <use xlink:href="#icon-star" x="24" width="24" height="24" transform="translate(4 0)"/>
</svg>`;

const styled = `<svg ${SVG} viewBox="0 0 100 100"><defs><style><![CDATA[
  .cls-1{fill:#0f172a;}
  .cls-2{fill:url(#linear-gradient);stroke:#fff;stroke-miterlimit:10;}
  .cls-1 > .inner, .cls-3:not(.x){opacity:.5}
  @media (prefers-color-scheme: dark){.cls-1{fill:#f8fafc}}
]]></style><linearGradient id="linear-gradient" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
<rect class="cls-1" width="100" height="100" rx="8"/><circle class="cls-2" cx="50" cy="50" r="30"/></svg>`;

const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg ${SVG} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="64" height="64" viewBox="0 0 64 64" sodipodi:docname="mark.svg" inkscape:version="1.3">
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" inkscape:zoom="8"/>
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><cc:Work xmlns:cc="http://creativecommons.org/ns#"/></rdf:RDF></metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <ellipse cx="32" cy="32" rx="28" ry="20" fill="#0ea5e9" filter="url(#shadow)"/>
  </g>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur"/>
    <feOffset dx="1" dy="2" in="blur" result="offset"/>
    <feMerge><feMergeNode in="offset"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</svg>`;

const raster = `<svg ${SVG} ${XLINK} viewBox="0 0 10 10"><image width="10" height="10" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/></svg>`;

const spinner = `<svg ${SVG} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" stroke-dasharray="40 20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/></circle></svg>`;

describe('sanitizeSvg keeps typical logos and icons rendering', () => {
  const benign: Record<string, [string, (name: string) => boolean]> = {
    'logo with gradients': [logo, name => !name.includes(':')],
    'icon set using use and symbol': [iconSet, name => !name.includes(':')],
    'style classes': [styled, name => !name.includes(':')],
    'embedded raster image': [raster, name => !name.includes(':')],
    'animated spinner': [spinner, name => !name.includes(':')],
    'inkscape export': [inkscape, name => !name.includes(':') && name !== 'metadata'],
  };
  for (const [name, [source, keep]] of Object.entries(benign)) {
    it(`preserves the ${name}`, () => {
      const { svg } = sanitizeSvg(Buffer.from(source));
      expect(structure(svg)).toEqual(structure(source, keep));
      expectInert(svg);
    });
  }

  it('keeps camelCase names, CSS and references byte-for-byte where they matter', () => {
    const { svg } = sanitizeSvg(Buffer.from(logo));
    for (const fragment of ['viewBox="0 0 240 80"', 'preserveAspectRatio="xMidYMid meet"', '<linearGradient id="grad" gradientUnits="userSpaceOnUse"',
      'gradientTransform="rotate(10)"', 'xlink:href="#grad"', '<clipPath id="clip" clipPathUnits="userSpaceOnUse">', 'clip-path="url(#clip)"',
      'fill="url(\'#glow\')"', 'Acme &amp; Co', 'style="stop-color:#FF7A00"', XLINK, 'xml:space="preserve"']) expect(svg).toContain(fragment);
    expect(svg).not.toContain('Illustrator');
    const styledOut = sanitizeSvg(Buffer.from(styled)).svg;
    expect(styledOut).toContain('.cls-2{fill:url(#linear-gradient);stroke:#fff;stroke-miterlimit:10;}');
    expect(styledOut).toContain('.cls-1 &gt; .inner');
    expect(styledOut).toContain('@media (prefers-color-scheme: dark){.cls-1{fill:#f8fafc}}');
    expect(sanitizeSvg(Buffer.from(raster)).svg).toContain('xlink:href="data:image/png;base64,iVBOR');
  });

  it('reads UTF-16 and declared legacy encodings as UTF-8 output', () => {
    const text = `<svg ${SVG}><title>Café</title></svg>`;
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(sanitizeSvg(utf16).svg).toBe(text);
    const latin1 = Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${text}`, 'latin1');
    expect(sanitizeSvg(latin1).bytes.toString('utf8')).toBe(text);
  });
});
