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
  // responsiveness, hover states, theming. stripCssExploits() below
  // scrubs the legacy code-execution / remote-load constructs from the
  // style content as a defense-in-depth pass.
  'style',
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
  nonBooleanAttributes: sanitizeHtml.defaults.nonBooleanAttributes.filter((name) => name !== 'download'),
  allowedAttributes: {
    // Schema.org microdata is passive metadata — keep it on every element
    // for rich-results support. Mirror with packages/portal/src/lib/sanitize.ts.
    '*': ['id', 'class', 'style', 'data-*', 'aria-*', 'role', 'lang', 'dir',
      'itemscope', 'itemtype', 'itemprop', 'itemref', 'itemid'],
    a: ['href', 'target', 'rel', 'title', 'download'],
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
  allowedIframeHostnames: [...DEFAULT_IFRAME_ALLOWED_HOSTS],
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  // Forbid every event-handler attribute by leaving them out of allowedAttributes.
  // sanitize-html also strips <script>, <object>, <embed> by default.
  // <style> is opted into explicitly via allowVulnerableTags.
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
  const cleaned = stripCssExploits(sanitizeHtml(protectedHtml, {
    ...options,
    allowedIframeHostnames: [...DEFAULT_IFRAME_ALLOWED_HOSTS, ...customHosts],
    allowedTags: [...allowedTags, 'tr-marker'],
    allowedAttributes: {
      ...options.allowedAttributes,
      'tr-marker': ['data-tr'],
    },
  }));
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
