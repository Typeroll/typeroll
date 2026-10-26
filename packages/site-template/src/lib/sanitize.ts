// Centralized sanitize-html config for customer-authored HTML.
//
// Customers write HTML for their own pages and partials, so we err on the
// permissive side: full markup including inline styles, classes, and most
// embed tags. We do NOT allow <script>, <object>, <embed>, or event handlers.
// Customers who need a third-party script add it via SiteSettings.scripts_*,
// which the layout drops into the page intentionally.

import sanitizeHtml, { type IOptions } from 'sanitize-html';
import { DEFAULT_IFRAME_ALLOWED_HOSTS, normalizeIframeAllowedHosts } from '@typeroll/shared/iframe-policy';

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  // <style> blocks are kept — multi-page sites need authored CSS for
  // responsiveness, hover states, theming — but are deliberately NOT listed
  // here: sanitizeBody() renames them to a per-call placeholder so their text
  // is escaped (see guardStyleText()). stripCssExploits() below scrubs the
  // legacy code-execution / remote-load constructs from the style content.
  // <x-include name="..."> survives sanitization at save time so the
  // partial reference reaches the build's expandIncludes step intact.
  'x-include',
  // HTML-mode form reference, expanded to the complete server-rendered form
  // shell before the final render-time sanitization pass.
  'x-form',
  // HTML-mode Extension reference, expanded to an inert runtime mount before
  // the final render-time sanitization pass.
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
  'ellipse',
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
  nonBooleanAttributes: sanitizeHtml.defaults.nonBooleanAttributes.filter((name) => !['download', 'hidden'].includes(name)),
  allowedAttributes: {
    // Schema.org microdata is passive metadata — keep it on every element
    // for rich-results support. Mirror with packages/portal/src/lib/sanitize.ts.
    '*': ['id', 'class', 'style', 'data-*', 'aria-*', 'role', 'lang', 'dir', 'hidden',
      'itemscope', 'itemtype', 'itemprop', 'itemref', 'itemid'],
    a: ['href', 'target', 'rel', 'title', 'download'],
    // An accordion's "Default open" (render version 4) opens items with <details open>.
    details: ['open'],
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
    input: ['type', 'name', 'value', 'placeholder', 'required', 'min', 'max', 'step', 'maxlength', 'pattern', 'autocomplete', 'checked', 'readonly', 'disabled', 'tabindex'],
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
  allowedIframeHostnames: [...DEFAULT_IFRAME_ALLOWED_HOSTS],
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  // URL-valued attributes (href, src, action, formaction, xlink:href, …) are
  // scheme-checked by sanitize-html's default allowedSchemesAppliedToAttributes;
  // sanitize-security.test.ts locks that in for form actions and SVG <use>.
  // Forbid every event-handler attribute by leaving them out of allowedAttributes.
  // sanitize-html also strips <script>, <object>, <embed> by default.
  // Authoring references such as <x-form /> must not absorb following HTML.
  parser: { lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  transformTags: {
    input: (tagName, attribs) => {
      if (attribs.tabindex !== '-1') delete attribs.tabindex;
      return { tagName, attribs };
    },
  },
  // Published pages are static and never handle credentials. A password field
  // in authored HTML can only collect a visitor's password for someone else.
  exclusiveFilter: (frame) => frame.tag === 'input'
    && String(frame.attribs.type ?? '').trim().toLowerCase() === 'password',
};

// Raw-text guard for <style> (mutation-XSS, security finding K1).
//
// sanitize-html re-emits the text of an allowed <style> verbatim. That text
// is not inert everywhere: inside <svg>/<math> (foreign content) a browser
// parses <style> content as markup and decodes entities, while htmlparser2
// either decodes entities itself or, at integration points that are later
// discarded (<foreignObject>, <mi>, …), passes raw markup through. Either way
// `<svg><style>&lt;img src=x onerror=…&gt;</style></svg>` used to come out as a
// live <img onerror>, with one more entity level surviving each extra pass.
//
// sanitizeBody therefore renames <style> to an unguessable placeholder tag.
// sanitize-html then treats its text like any other text and escapes it, and
// the textFilter below decides per text node:
//   - outside any <svg>/<math> ancestor, htmlparser2 and the browser both read
//     the content as raw text that ends at the first `</style`. The escaping is
//     undone exactly, so ordinary page CSS is byte-for-byte unchanged.
//   - with an <svg>/<math> ancestor the text stays escaped, so it contains no
//     `<` and can never open a tag. Browsers decode the entities in foreign
//     <style>, so SVG CSS such as `.a > .b` keeps its meaning.
// The placeholder is renamed back to <style> afterwards. Its random name
// cannot appear in raw CSS, so the rename cannot be steered by content.
const ESCAPED_TEXT_ENTITY_RE = /&(amp|lt|gt);/g;
const ESCAPED_TEXT_CHARS: Record<string, string> = { amp: '&', lt: '<', gt: '>' };

function isForeignContentRoot(name: string): boolean {
  return name === 'svg' || name === 'math';
}

function guardStyleText(): Pick<IOptions, 'transformTags' | 'onOpenTag' | 'onCloseTag' | 'textFilter'> & { placeholder: string } {
  const placeholder = `tr-style-${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  const openElements: string[] = [];
  return {
    placeholder,
    transformTags: {
      ...options.transformTags,
      style: (_tagName, attribs) => ({ tagName: placeholder, attribs }),
    },
    onOpenTag: (name) => {
      openElements.push(name);
    },
    onCloseTag: (name) => {
      const index = openElements.lastIndexOf(name);
      if (index !== -1) openElements.length = index;
    },
    textFilter: (text, tagName) => {
      if (tagName !== 'style' || openElements.some(isForeignContentRoot)) return text;
      // sanitize-html (decodeEntities: true) escapes exactly &, < and >.
      return text.replace(ESCAPED_TEXT_ENTITY_RE, (_m, name: string) => ESCAPED_TEXT_CHARS[name]);
    },
  };
}

function restoreStyleTags(html: string, placeholder: string): string {
  return html.split(`<${placeholder}`).join('<style').split(`</${placeholder}>`).join('</style>');
}

/**
 * Scrub CSS constructs that can execute code or pull external resources.
 * Kept in lockstep with packages/portal/src/lib/sanitize.ts:stripCssExploits.
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

// Mirror of packages/portal/src/lib/sanitize.ts — typeroll-prefixed
// HTML comments survive sanitization so regenerate_collection_listing's
// markers don't disappear on the next page edit. See the longer
// explanation in the portal sibling.
const TYPEROLL_MARKER_RE = /<!--\s*(\/?typeroll:[^>]+?|[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})\s*-->/g;
const TYPEROLL_TOKEN_RE = /<tr-marker\b[^>]*\bdata-tr="([^"]+)"[^>]*><\/tr-marker>/g;

function protectMarkers(html: string): string {
  return html.replace(TYPEROLL_MARKER_RE, (_m, payload: string) => {
    if (!/^[\/a-zA-Z0-9:._\- ]+$/.test(payload)) return '';
    return `<tr-marker data-tr="${payload}"></tr-marker>`;
  });
}

function restoreMarkers(html: string): string {
  return html.replace(TYPEROLL_TOKEN_RE, (_m, payload: string) => `<!-- ${payload} -->`);
}

export function sanitizeBody(html: string, iframeAllowedHosts: string[] = []): string {
  const customHosts = normalizeIframeAllowedHosts(iframeAllowedHosts).hosts;
  const protectedHtml = protectMarkers(html);
  const { placeholder, ...styleGuard } = guardStyleText();
  const cleaned = stripCssExploits(restoreStyleTags(sanitizeHtml(protectedHtml, {
    ...options,
    ...styleGuard,
    allowedIframeHostnames: [...DEFAULT_IFRAME_ALLOWED_HOSTS, ...customHosts],
    allowedTags: [...allowedTags, 'tr-marker', placeholder],
    allowedAttributes: {
      ...options.allowedAttributes,
      'tr-marker': ['data-tr'],
    },
  }), placeholder));
  return restoreSvgAttrCase(restoreMarkers(cleaned));
}

// Mirror of packages/portal/src/lib/sanitize.ts — restore the documented
// camelCase SVG attribute names inside <svg>…</svg> blocks after
// sanitize-html's lowercase pass. See the longer explanation in the
// portal sibling.
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

const SVG_CAMEL_TAGS = ['linearGradient', 'radialGradient', 'clipPath'] as const;

function restoreSvgAttrCase(html: string): string {
  if (!html.includes('<svg')) return html;
  return html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svgBlock) => {
    let out = svgBlock;
    for (const camel of SVG_CAMEL_ATTRS) {
      const lower = camel.toLowerCase();
      out = out.replace(new RegExp(`\\b${lower}=`, 'g'), `${camel}=`);
    }
    for (const camel of SVG_CAMEL_TAGS) {
      const lower = camel.toLowerCase();
      out = out.replace(new RegExp(`<${lower}(?=[\\s>/])`, 'g'), `<${camel}`);
      out = out.replace(new RegExp(`</${lower}>`, 'g'), `</${camel}>`);
    }
    return out;
  });
}
