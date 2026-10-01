// Media clean-up for imported HTML (WordPress migration): restores lazy-loaded
// images and iframes and drops <noscript> fallbacks that duplicate them. The
// HTML stays HTML; Typeroll never converts imported HTML into blocks.

import * as htmlparser2 from 'htmlparser2';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

interface Node {
  type: 'text' | 'tag' | 'script' | 'style';
  name?: string;
  attribs?: Record<string, string>;
  children?: Node[];
  data?: string;
}

/** Apply the browser's tree-construction rules to the original input first.
 * Serializing a permissive parser's repaired tree before this step can move
 * media across malformed WordPress heading/paragraph boundaries permanently.
 */
function parseRawHtml(html: string): Node[] {
  function adapt(node: DefaultTreeAdapterMap['childNode']): Node[] {
    if (node.nodeName === '#text') return [{ type: 'text', data: (node as DefaultTreeAdapterMap['textNode']).value }];
    if (!('tagName' in node)) return [];
    return [{ type: node.tagName === 'script' ? 'script' : node.tagName === 'style' ? 'style' : 'tag',
      name: node.tagName,
      attribs: Object.fromEntries(node.attrs.map(attr => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value])),
      children: node.childNodes.flatMap(adapt),
    }];
  }
  // Migration restores noscript fallbacks without executing scripts.
  return parseFragment(html, { scriptingEnabled: false }).childNodes.flatMap(adapt);
}

/** Restore lazy images/iframes before the WordPress sanitizer removes data attributes. */
export function normalizeImportedMediaHtml(html: string): string {
  const nodes = parseRawHtml(html);
  return htmlparser2.DomUtils.getOuterHTML(normalizeLazyMedia(nodes) as unknown as Parameters<typeof htmlparser2.DomUtils.getOuterHTML>[0]);
}

/** Restore lazy media and drop a fallback only when the same media is present. */
function normalizeLazyMedia(nodes: Node[]): Node[] {
  nodes = nodes.map(node => {
    if (node.name === 'img' && node.attribs?.['data-lazy-type'] === 'iframe') {
      const restored = parseRawHtml(node.attribs['data-lazy-src'] ?? '');
      if (restored.length === 1 && restored[0].name === 'iframe') return restored[0];
    }
    if (['img', 'source', 'iframe'].includes(node.name ?? '') && node.attribs) {
      const attrs = { ...node.attribs };
      if (attrs['data-lazy-src'] || attrs['data-src']) attrs.src = attrs['data-lazy-src'] || attrs['data-src'];
      if (attrs['data-lazy-srcset'] || attrs['data-srcset']) attrs.srcset = attrs['data-lazy-srcset'] || attrs['data-srcset'];
      node = { ...node, attribs: attrs };
    }
    return { ...node, ...(node.children ? { children: normalizeLazyMedia(node.children) } : {}) };
  });
  const imageSource = (node: Node) => node.attribs?.['data-lazy-src'] || node.attribs?.['data-src'] || node.attribs?.src || '';
  const imageSources = (node: Node): string[] => node.name === 'noscript' ? []
    : ['img', 'iframe'].includes(node.name ?? '') ? [node.name + ':' + imageSource(node)] : (node.children ?? []).flatMap(imageSources);
  const present = new Set(nodes.flatMap(imageSources));
  return nodes.flatMap(node => {
    if (node.name === 'noscript') {
      const children = node.children ?? [];
      const images = children.filter(child => ['img', 'iframe'].includes(child.name ?? ''));
      const onlyImages = children.every(child => ['img', 'iframe'].includes(child.name ?? '') || (child.type === 'text' && !child.data?.trim()));
      if (onlyImages && images.length && images.every(image => present.has(image.name + ':' + imageSource(image)))) return [];
      if (onlyImages && images.length) return images;
    }
    return [node];
  });
}
