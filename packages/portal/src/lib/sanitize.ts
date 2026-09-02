// Centralized sanitize-html config for customer-authored HTML.
//
// Customers write HTML for their own pages and partials, so we err on the
// permissive side: full markup including inline styles, classes, and most
// embed tags. We do NOT allow <script>, <object>, <embed>, or event handlers.
// Customers who need a third-party script add it via SiteSettings.scripts_*,
// which the layout drops into the page intentionally.

import sanitizeHtml, { type IOptions } from 'sanitize-html';

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  // <style> blocks inside customer HTML are kept. The content is scrubbed
  // by stripCssExploits() below to remove the small set of legacy CSS
  // constructs that can execute JS (expression(), behavior:url, etc.) and
  // remote-load risks (@import, url(javascript:)). Modern browsers ignore
  // most of these anyway, but we belt-and-brace because the cost is one
  // regex pass.
  'style',
  // <x-include name="..."> — first-class partial reference in a page's
  // html_content. expandIncludes() at render time replaces these with
  // the named partial's body. Must survive sanitization at save time;
  // otherwise update_page strips it silently and the page renders with
  // a hole where the include used to be. (Reported by Sundsvallsflytt
  // demo build, 2026-05.)
  'x-include',
  // Server-rendered form reference for HTML-mode pages. Preview and static
  // generation replace this with the complete form shell and initial state.
  'x-form',
  // HTML-mode reference to an installed Extension block. Expanded to an
  // inert mount shell before final render sanitization.
  'x-extension',
  // Common page tags missing from defaults
  'img',
  'figure',
  'figcaption',
  'picture',
  'source',
  'video',
  'audio',
  'iframe', // YouTube/Vimeo embeds need this
  'svg',
  'path',
  'g',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'use',
  'defs',
  // sanitize-html has changed SVG tag casing across htmlparser2 versions:
  // older versions lowercased these names, while current versions preserve
  // their canonical case. Allow both forms; the post-pass normalizes output
  // for XML-correct serialization.
  'lineargradient',
  'linearGradient',
  'radialgradient',
  'radialGradient',
  'stop',
  'mask',
  'clippath',
  'clipPath',
  'pattern',
  'symbol',
  'title',
  'desc',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'time',
  'mark',
  'small',
  'sub',
  'sup',
  'details',
  'summary',
  'dialog',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'label',
  'fieldset',
  'legend',
];

const options: IOptions = {
  allowedTags,
  allowedAttributes: {
    // Schema.org microdata (itemscope/itemtype/itemprop/itemref/itemid) are
    // passive metadata attributes — no security risk, drive Google rich
    // results. Allowed on every element so a page can mark up
    // PostalAddress / Article / Product etc. inline. Page.json_ld
    // remains the recommended path for complex structured data, but
    // microdata is sometimes simpler for small annotations.
    '*': ['id', 'class', 'style', 'data-*', 'aria-*', 'role', 'lang', 'dir',
      'itemscope', 'itemtype', 'itemprop', 'itemref', 'itemid'],
    a: ['href', 'target', 'rel', 'title'],
    'x-include': ['name'],
    'x-form': ['id'],
    'x-extension': ['block', 'props'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    source: ['src', 'srcset', 'type', 'media', 'sizes'],
    video: ['src', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'preload', 'width', 'height'],
    audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload'],
    iframe: ['src', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'loading', 'sandbox', 'referrerpolicy'],
    // SVG icon set (matches Lucide / Heroicons / Feather conventions: stroke
    // attributes are usually set on the <svg> root so every child inherits).
    // The presentational attributes here are paint/geometry only — no event
    // handlers, no external refs.
    svg: [
      'xmlns', 'viewbox', 'width', 'height', 'preserveaspectratio',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
      'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity',
      'aria-hidden', 'focusable',
    ],
    g: [
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'fill-rule', 'clip-rule', 'opacity', 'transform', 'mask', 'clip-path',
    ],
    path: [
      'd',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
      'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity',
      'transform', 'mask', 'clip-path',
    ],
    circle: [
      'cx', 'cy', 'r',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
    ],
    rect: [
      'x', 'y', 'width', 'height', 'rx', 'ry',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
    ],
    line: [
      'x1', 'y1', 'x2', 'y2',
      'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'stroke-opacity', 'opacity', 'transform',
    ],
    polyline: [
      'points',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
    ],
    polygon: [
      'points',
      'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
      'fill-rule', 'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
    ],
    ellipse: [
      'cx', 'cy', 'rx', 'ry',
      'fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
    ],
    text: ['x', 'y', 'dx', 'dy', 'text-anchor', 'fill', 'font-size', 'font-family', 'font-weight', 'transform'],
    tspan: ['x', 'y', 'dx', 'dy', 'text-anchor', 'fill', 'font-size', 'font-family', 'font-weight'],
    use: ['x', 'y', 'width', 'height', 'href', 'xlink:href', 'transform'],
    // sanitize-html lowercases attribute names at parse time, so allowlist
    // entries must be lowercase too — the camelCase SVG attribute names
    // wouldn't match otherwise. HTML5's inline-SVG parsing is case-insensitive
    // for these so browsers still render them correctly.
    lineargradient: ['x1', 'y1', 'x2', 'y2', 'gradientunits', 'gradienttransform', 'spreadmethod'],
    linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientunits', 'gradienttransform', 'spreadmethod'],
    radialgradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientunits', 'gradienttransform', 'spreadmethod'],
    radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientunits', 'gradienttransform', 'spreadmethod'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    mask: ['x', 'y', 'width', 'height', 'maskunits', 'maskcontentunits'],
    clippath: ['clippathunits'],
    clipPath: ['clippathunits'],
    pattern: ['x', 'y', 'width', 'height', 'patternunits', 'patterntransform', 'viewbox'],
    symbol: ['viewbox', 'preserveaspectratio'],
    form: ['action', 'method', 'enctype', 'target', 'name'],
    input: ['type', 'name', 'value', 'placeholder', 'required', 'min', 'max', 'pattern', 'autocomplete', 'checked', 'readonly', 'disabled', 'tabindex'],
    textarea: ['name', 'placeholder', 'required', 'rows', 'cols'],
    select: ['name', 'required', 'multiple'],
    option: ['value', 'selected'],
    button: ['type', 'name', 'value'],
    label: ['for'],
    table: ['border', 'cellpadding', 'cellspacing'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  // Restrict iframe sources to common embed providers + same origin
  allowedIframeHostnames: [
    'www.youtube.com',
    'youtube.com',
    'www.youtube-nocookie.com',
    'player.vimeo.com',
    'vimeo.com',
    'www.google.com',
    'maps.google.com',
    'calendly.com',
  ],
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  // Forbid every event-handler attribute by leaving them out of allowedAttributes.
  // sanitize-html also strips <script>, <object>, <embed> by default.
  // <style> is allowed because we need authored CSS for multi-page sites;
  // sanitize-html flags it as a "vulnerable tag" which we explicitly opt into.
  allowVulnerableTags: true,
  parser: { lowerCaseAttributeNames: true },
  transformTags: {
    input: (tagName, attribs) => {
      if (attribs.tabindex !== '-1') delete attribs.tabindex;
      return { tagName, attribs };
    },
  },
};

/**
 * Scrub the small set of CSS constructs that can execute code or pull
 * external resources. Runs over the post-sanitize output. Modern browsers
 * already ignore most of these — we strip anyway so a malicious paste
 * doesn't fool a future browser quirk. Order:
 *   1. expression(...) — IE legacy, executes JS
 *   2. behavior: url(...) — IE legacy, loads HTC component
 *   3. -moz-binding: url(...) — old Firefox, loads XBL
 *   4. @import — fetches external CSS (data exfil / fingerprint risk)
 *   5. url(javascript:...) — historical XSS vector
 */
function stripCssExploits(html: string): string {
  return html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    let scrubbed = css
      .replace(/expression\s*\([^)]*\)/gi, '/* expression() stripped */')
      .replace(/behavior\s*:\s*url\([^)]*\)/gi, '/* behavior:url stripped */')
      .replace(/-moz-binding\s*:\s*url\([^)]*\)/gi, '/* -moz-binding stripped */')
      .replace(/@import\b[^;]*;?/gi, '/* @import stripped */')
      .replace(/url\(\s*['"]?\s*javascript:[^)]*\)/gi, 'url(/* javascript: stripped */)');
    return `<style>${scrubbed}</style>`;
  });
}

// sanitize-html drops HTML comments unconditionally. That's fine for
// generic comments, but Typeroll uses `<!-- typeroll:listing:NAME -->` and
// `<!-- /typeroll:listing:NAME -->` pairs as anchors that
// regenerate_collection_listing rewrites between. The first regenerate-
// listing call writes the markers; any subsequent update_page (which runs
// the body through sanitizeBody) used to silently strip them, and the next
// regenerate call would fail with "markers not found". That's the C1 bug
// reported from the autopilot.se /podd build, 2026-05.
//
// Fix: tokenize the typeroll-prefixed comments into a placeholder element
// the sanitizer doesn't touch, then restore the comment shape after
// sanitization. Plain prose comments are still dropped. The token tag
// (`tr-marker`) is intentionally lowercase + kebab-case so it survives
// sanitize-html's lowercase pass; the inner payload sits in a `data-tr`
// attribute so the round-trip is byte-exact (no whitespace drift inside
// the marker).
const TYPEROLL_MARKER_RE = /<!--\s*(\/?typeroll:[^>]+?)\s*-->/g;
const TYPEROLL_TOKEN_RE = /<tr-marker\b[^>]*\bdata-tr="([^"]+)"[^>]*><\/tr-marker>/g;

function protectMarkers(html: string): string {
  return html.replace(TYPEROLL_MARKER_RE, (_m, payload: string) => {
    // The payload is opaque-ish — restrict to what regenerate-listing
    // emits so a malicious page can't inject HTML through this channel.
    // Allowed: ASCII alphanumerics, `:` `/` `-` `_` `.` and a space.
    if (!/^[\/a-zA-Z0-9:._\- ]+$/.test(payload)) return '';
    return `<tr-marker data-tr="${payload}"></tr-marker>`;
  });
}

function restoreMarkers(html: string): string {
  return html.replace(TYPEROLL_TOKEN_RE, (_m, payload: string) => `<!-- ${payload} -->`);
}

export function sanitizeBody(html: string): string {
  const protectedHtml = protectMarkers(html);
  const cleaned = stripCssExploits(sanitizeHtml(protectedHtml, {
    ...options,
    allowedTags: [...allowedTags, 'tr-marker'],
    allowedAttributes: {
      ...options.allowedAttributes,
      'tr-marker': ['data-tr'],
    },
  }));
  return restoreSvgAttrCase(restoreMarkers(cleaned));
}

// sanitize-html's underlying htmlparser2 lowercases every attribute name
// (`parser.lowerCaseAttributeNames: true` is its HTML-mode default). That's
// fine for HTML — attribute names are case-insensitive there — but several
// SVG attributes are case-sensitive when the document is interpreted as
// XML (strict XHTML serialization, downstream tooling, JSX/MDX). The
// browser tolerates `viewbox=` in HTML SVG islands, so most rendering is
// unaffected; the risk is round-tripping content through an XML-aware
// pipeline that does NOT silently rewrite it. Reported from autopilot.se
// 2026-05 — the migration's SVG icons emerged as `viewbox` and would have
// broken if the same content were ever exported as XHTML.
//
// Fix: post-pass that restores the documented set of camelCase SVG
// attribute names inside <svg>…</svg> blocks. The list is the well-known
// MDN/spec inventory; expand it when a new SVG attribute crosses our path.
// The replacement only touches `<svg>…</svg>` regions so a non-SVG
// attribute that happens to share a lowercase form (unlikely but cheap to
// guarantee) can't be misrewritten.
const SVG_CAMEL_ATTRS = [
  'viewBox',
  'preserveAspectRatio',
  'clipPathUnits',
  'gradientUnits',
  'gradientTransform',
  'patternUnits',
  'patternTransform',
  'patternContentUnits',
  'maskUnits',
  'maskContentUnits',
  'markerUnits',
  'markerWidth',
  'markerHeight',
  'refX',
  'refY',
  'spreadMethod',
  'startOffset',
  'stdDeviation',
  'baseFrequency',
  'numOctaves',
  'kernelMatrix',
  'kernelUnitLength',
  'pathLength',
  'lengthAdjust',
  'textLength',
  'systemLanguage',
  'xChannelSelector',
  'yChannelSelector',
  'specularConstant',
  'specularExponent',
  'surfaceScale',
  'pointsAtX',
  'pointsAtY',
  'pointsAtZ',
  'limitingConeAngle',
  'diffuseConstant',
  'edgeMode',
  'targetX',
  'targetY',
  'tableValues',
] as const;

// Same story as the attributes — sanitize-html lowercases these SVG tag
// names. Restoring keeps XML-serialized output spec-correct. Browsers
// would render the lowercase form fine in HTML, but the value of the
// post-pass is the XML round-trip.
const SVG_CAMEL_TAGS = ['linearGradient', 'radialGradient', 'clipPath'] as const;

function restoreSvgAttrCase(html: string): string {
  if (!html.includes('<svg')) return html;
  return html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svgBlock) => {
    let out = svgBlock;
    for (const camel of SVG_CAMEL_ATTRS) {
      const lower = camel.toLowerCase();
      // `\b<lower>=` matches attribute name immediately followed by `=`;
      // sanitize-html normalises away whitespace before `=` so this is
      // exhaustive on output. The trailing `=` avoids matching tokens
      // that happen to share the name within text or another attribute's
      // value.
      out = out.replace(new RegExp(`\\b${lower}=`, 'g'), `${camel}=`);
    }
    for (const camel of SVG_CAMEL_TAGS) {
      const lower = camel.toLowerCase();
      // Opening tag: `<lineargradient ` / `<lineargradient>` / `<lineargradient/>`.
      out = out.replace(new RegExp(`<${lower}(?=[\\s>/])`, 'g'), `<${camel}`);
      // Closing tag.
      out = out.replace(new RegExp(`</${lower}>`, 'g'), `</${camel}>`);
    }
    return out;
  });
}
