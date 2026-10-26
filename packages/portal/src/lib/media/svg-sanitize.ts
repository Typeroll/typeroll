// Strict allowlist sanitizer for stored SVG media.
//
// An SVG opened directly from the media host (or from the website host when
// media is delivered statically) is a document in that origin: scripts, event
// handlers, javascript: links, <foreignObject> HTML, XSLT processing
// instructions or animated hrefs would all run there. Media is therefore
// stored only after it has been reduced to static vector graphics.
//
// The input is parsed as XML (htmlparser2 in xmlMode keeps camelCase names
// such as viewBox and linearGradient) and the output is re-serialized from the
// parsed tree, so a browser only ever sees names from the allowlists below and
// values escaped by this module. Anything else is dropped. Input that is not a
// well-formed SVG document is rejected rather than repaired.

import { Parser } from 'htmlparser2';

export class SvgSanitizeError extends Error {
  /** `truncated` when the document ends early, which usually means an interrupted upload. */
  constructor(message: string, public kind: 'invalid' | 'truncated' = 'invalid') { super(message); }
}

export interface SvgSanitizeResult {
  /** Sanitized document, UTF-8, without an XML declaration. */
  svg: string;
  bytes: Buffer;
  /** Kinds of content that were removed, for logs and API responses. */
  removed: string[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  'animate', 'animateTransform', 'animateMotion', 'set', 'mpath',
]);
/** Links become plain groups: their children keep rendering, the link does not. */
const RENAMED: Record<string, string> = { a: 'g' };
const ANIMATIONS = new Set(['animate', 'animateTransform', 'animateMotion', 'set']);
/** Elements whose href may embed a raster image as a data: URI. */
const RASTER_HREF = new Set(['image', 'feImage']);

const ATTRIBUTES = new Set([
  // Core and accessibility
  'id', 'class', 'style', 'lang', 'xml:space', 'xml:lang', 'role', 'focusable',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-roledescription',
  'requiredFeatures', 'requiredExtensions', 'systemLanguage', 'version', 'baseProfile',
  // Presentation
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering', 'cursor', 'direction', 'display', 'dominant-baseline',
  'enable-background', 'fill', 'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font',
  'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight',
  'glyph-orientation-horizontal', 'glyph-orientation-vertical', 'image-rendering', 'isolation', 'letter-spacing',
  'lighting-color', 'marker', 'marker-end', 'marker-mid', 'marker-start', 'mask', 'mask-type', 'mix-blend-mode',
  'opacity', 'overflow', 'paint-order', 'pointer-events', 'shape-rendering', 'stop-color', 'stop-opacity',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-width', 'text-anchor', 'text-decoration', 'text-rendering', 'transform',
  'transform-origin', 'unicode-bidi', 'vector-effect', 'visibility', 'word-spacing', 'writing-mode',
  // Geometry, text, paint servers and structure
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'pathLength', 'dx', 'dy', 'rotate', 'textLength',
  'lengthAdjust', 'startOffset', 'method', 'spacing', 'side', 'gradientUnits', 'gradientTransform',
  'spreadMethod', 'offset', 'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
  'media', 'type',
  // Filter primitives
  'filterUnits', 'primitiveUnits', 'filterRes', 'in', 'in2', 'result', 'mode', 'values', 'tableValues',
  'slope', 'intercept', 'amplitude', 'exponent', 'k1', 'k2', 'k3', 'k4', 'operator', 'order', 'kernelMatrix',
  'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLength', 'preserveAlpha', 'surfaceScale',
  'diffuseConstant', 'specularConstant', 'specularExponent', 'scale', 'xChannelSelector', 'yChannelSelector',
  'stdDeviation', 'radius', 'azimuth', 'elevation', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'limitingConeAngle', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles',
  // Declarative animation (attributeName is checked separately)
  'attributeName', 'attributeType', 'begin', 'dur', 'end', 'min', 'max', 'restart', 'repeatCount',
  'repeatDur', 'calcMode', 'keyTimes', 'keySplines', 'keyPoints', 'from', 'to', 'by', 'additive',
  'accumulate', 'path', 'origin',
  // Local references only (checked separately)
  'href', 'xlink:href',
]);
/** Attributes an animation may never target. */
const UNANIMATABLE = new Set(['href', 'xlink:href', 'style', 'id', 'attributeName', 'begin', 'end', 'type', 'media']);

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
/** Tokens that load resources or run code, wherever they appear in a value. */
const FORBIDDEN_VALUE = /javascript:|vbscript:|livescript:|expression\s*\(|@import|-moz-binding|behavior\s*:|image-set\s*\(|(?:^|[^a-z-])image\s*\(|cross-fade\s*\(|(?:^|[^a-z-])src\s*\(|element\s*\(/i;

function decode(input: Uint8Array): string {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) throw new SvgSanitizeError('Compressed SVG (SVGZ) is not supported. Upload an uncompressed .svg file.');
  let label = 'utf-8', offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; offset = 2; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { label = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0x3c && bytes[1] === 0x00) label = 'utf-16le';
  else if (bytes[0] === 0x00 && bytes[1] === 0x3c) label = 'utf-16be';
  else {
    const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(bytes.subarray(0, 200).toString('latin1'))?.[1]?.toLowerCase();
    if (declared && declared !== 'utf-8' && declared !== 'utf8') label = declared;
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new SvgSanitizeError(`The SVG text encoding (${label}) could not be read.`);
  }
}

/** Remove the XML declaration, processing instructions, comments and any DOCTYPE (with its internal subset) before the root element. */
function stripProlog(text: string, removed: Set<string>): string {
  let index = 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      if (end < 0) throw new SvgSanitizeError('The SVG has an unterminated processing instruction.', 'truncated');
      index = end + 2;
    } else if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end < 0) throw new SvgSanitizeError('The SVG has an unterminated comment.', 'truncated');
      index = end + 3;
    } else if (text.startsWith('<!DOCTYPE', index)) {
      let depth = 0, quote = '', i = index + 9;
      for (; i < text.length; i++) {
        const char = text[i];
        if (quote) { if (char === quote) quote = ''; continue; }
        if (depth > 0 && text.startsWith('<!--', i)) {
          const end = text.indexOf('-->', i + 4);
          if (end < 0) break;
          i = end + 2; continue;
        }
        if (char === '"' || char === '\'') quote = char;
        else if (char === '[') depth++;
        else if (char === ']') depth--;
        else if (char === '>' && depth <= 0) break;
      }
      if (i >= text.length) throw new SvgSanitizeError('The SVG has an unterminated DOCTYPE.', 'truncated');
      removed.add('doctype');
      index = i + 1;
    } else {
      return text.slice(index);
    }
  }
}

function escapeText(value: string): string {
  return value.replace(new RegExp(CONTROL.source, 'g'), '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Every url(...) in a value must point to a fragment in this document. */
function urlsAreLocal(value: string): boolean {
  const pattern = /url\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const rest = value.slice(match.index + match[0].length);
    const target = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s)"']*))\s*\)/.exec(rest);
    if (!target) return false;
    const url = (target[1] ?? target[2] ?? target[3] ?? '').trim();
    if (!/^#[^\s#]*$/.test(url)) return false;
  }
  return true;
}

function valueIsSafe(value: string): boolean {
  return !CONTROL.test(value) && !value.includes('\\') && !FORBIDDEN_VALUE.test(value) && urlsAreLocal(value);
}

/**
 * Keep CSS that cannot load or run anything. The text is cut at every `{`,
 * `}` and `;`; a piece with a non-fragment url(), an @import, an escape or
 * another forbidden token is removed in full. Cutting more than a real CSS
 * parser would only ever removes text, so no new construct can be formed.
 */
export function sanitizeSvgCss(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\*/.test(text) || text.includes('<')) return '';
  let out = '';
  for (const piece of text.split(/([{};])/)) {
    if (piece === '{' || piece === '}' || piece === ';') out += piece;
    else if (!piece.trim() || valueIsSafe(piece)) out += piece;
    else out += piece.match(/^\s*/)![0];
  }
  return out.trim() ? out : '';
}

function localHref(value: string): string | null {
  const trimmed = value.trim();
  return /^#[^\s#]*$/.test(trimmed) && !CONTROL.test(trimmed) ? trimmed : null;
}

interface Frame { name: string; dropped: boolean; children: boolean; style: boolean }

/** Sanitize SVG bytes. Throws SvgSanitizeError when the input is not a well-formed SVG document. */
export function sanitizeSvg(input: Uint8Array | string): SvgSanitizeResult {
  const text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decode(input);
  const removed = new Set<string>();
  const body = stripProlog(text, removed);
  if (!/^<svg[\s/>]/.test(body)) throw new SvgSanitizeError('The file is not an SVG image: its root element must be <svg>.');

  const out: string[] = [];
  const stack: Frame[] = [];
  let rootIndex = -1, rootClosed = false, usesXlink = false, failure: string | null = null;
  let tagName = '', attributes: Array<[string, string]> = [], seen = new Set<string>();
  let styleText = '', ending = false;

  const fail = (message: string) => { failure ??= message; };
  const dropping = () => stack.some(frame => frame.dropped);
  const flushOpenTag = () => {
    const parent = stack[stack.length - 1];
    if (parent && !parent.dropped && !parent.children) { out.push('>'); parent.children = true; }
  };

  const parser = new Parser({
    onopentagname(name) { tagName = name; attributes = []; seen = new Set(); },
    onattribute(name, value) {
      if (seen.has(name)) fail(`The SVG repeats the attribute ${name} on <${tagName}>.`);
      seen.add(name); attributes.push([name, value]);
    },
    onopentag(name) {
      if (rootClosed) { fail('The SVG has content after its root element.'); return; }
      const isRoot = stack.length === 0;
      if (isRoot && name !== 'svg') { fail('The root element must be <svg>.'); return; }
      const outputName = RENAMED[name] ?? name;
      let dropped = dropping() || !ELEMENTS.has(outputName);
      if (!dropping() && dropped) removed.add(name === 'script' ? 'script' : name === 'foreignObject' ? 'foreignObject' : 'element');
      const parentIsStyle = stack[stack.length - 1]?.style;
      if (!dropped && parentIsStyle) { dropped = true; removed.add('element'); }
      const kept: string[] = [];
      if (!dropped) {
        if (ANIMATIONS.has(outputName)) {
          const target = attributes.find(([attr]) => attr === 'attributeName')?.[1]?.trim() ?? '';
          if (target && (!ATTRIBUTES.has(target) || UNANIMATABLE.has(target) || /^on/i.test(target))) { dropped = true; removed.add('animation'); }
        }
        if (outputName === 'style') {
          const type = attributes.find(([attr]) => attr === 'type')?.[1]?.trim().toLowerCase();
          if (type && type !== 'text/css') { dropped = true; removed.add('style'); }
        }
      }
      if (!dropped) {
        for (const [attr, raw] of attributes) {
          if (attr === 'xmlns' || attr === 'xmlns:xlink') continue; // re-declared on the root
          if (/^on/i.test(attr)) { removed.add('event handler'); continue; }
          if (!ATTRIBUTES.has(attr)) { removed.add('attribute'); continue; }
          if (attr === 'href' || attr === 'xlink:href') {
            if (name === 'a') { removed.add('link'); continue; }
            const local = localHref(raw);
            const value = local ?? (RASTER_HREF.has(outputName) && RASTER_DATA_URI.test(raw.trim()) ? raw.trim().replace(/\s+/g, '') : null);
            if (!value) { removed.add('external reference'); continue; }
            if (attr === 'xlink:href') usesXlink = true;
            kept.push(` ${attr}="${escapeAttribute(value)}"`);
            continue;
          }
          if (attr === 'style') {
            const css = sanitizeSvgCss(raw);
            if (css !== raw) removed.add('style');
            if (css.trim()) kept.push(` style="${escapeAttribute(css)}"`);
            continue;
          }
          if (!valueIsSafe(raw)) { removed.add('unsafe value'); continue; }
          kept.push(` ${attr}="${escapeAttribute(raw)}"`);
        }
      }
      const frame: Frame = { name, dropped, children: false, style: !dropped && outputName === 'style' };
      if (!dropped) {
        flushOpenTag();
        if (isRoot) rootIndex = out.length;
        out.push(`<${outputName}${kept.join('')}`);
      }
      if (frame.style) styleText = '';
      stack.push(frame);
    },
    onclosetag(name, isImplied) {
      // Elements still open at the end of input: the file ends early.
      if (ending) return;
      const frame = stack.pop();
      if (!frame) return;
      // htmlparser2 reports `<tag/>` as an implied close at that tag's `/>`;
      // any other implied close is a missing or mismatched end tag.
      if (isImplied && !(body[parser.endIndex] === '>' && body[parser.endIndex - 1] === '/')) fail(`The SVG element <${frame.name}> is not closed.`);
      if (frame.name !== name) fail(`The SVG closes <${name}> where <${frame.name}> is open.`);
      if (!frame.dropped) {
        if (frame.style) {
          const css = sanitizeSvgCss(styleText);
          if (css !== styleText) removed.add('style');
          if (css.trim()) { out.push('>', escapeText(css)); frame.children = true; }
        }
        out.push(frame.children ? `</${RENAMED[frame.name] ?? frame.name}>` : '/>');
      }
      if (stack.length === 0) rootClosed = true;
    },
    ontext(value) {
      if (stack.length === 0) {
        if (value.trim()) fail('The SVG has text outside its root element.');
        return;
      }
      if (dropping()) return;
      const parent = stack[stack.length - 1];
      if (parent.style) { styleText += value; return; }
      flushOpenTag();
      out.push(escapeText(value));
    },
    oncomment() { removed.add('comment'); },
    onprocessinginstruction(name) {
      if (name.startsWith('!')) fail('The SVG contains a markup declaration (DOCTYPE or ENTITY) inside the document.');
      else removed.add('processing instruction');
    },
  }, { xmlMode: true, decodeEntities: true });
  parser.write(body);
  ending = true;
  parser.end();
  if (failure) throw new SvgSanitizeError(failure);
  if (!rootClosed || rootIndex < 0) throw new SvgSanitizeError('The SVG root element is not closed.', 'truncated');

  const root = out[rootIndex];
  out[rootIndex] = `<svg xmlns="${SVG_NS}"${usesXlink ? ` xmlns:xlink="${XLINK_NS}"` : ''}${root.slice(4)}`;
  const svg = out.join('');
  return { svg, bytes: Buffer.from(svg, 'utf8'), removed: [...removed].sort() };
}
