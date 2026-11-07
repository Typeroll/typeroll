/**
 * Live snippets on pages: the `core/snippet` block shows a snippet's content
 * as of the publication (for dated snippets the entry of the build date in
 * the site time zone), so the content is there without script, for search
 * engines and in print. When the site has a live base URL the block also
 * names its live file (`<live_base_url>/<id>.json`), and SNIPPET_LIVE_SCRIPT
 * fetches it and shows the newest content, choosing today's entry in the
 * visitor's browser with SNIPPET_CONTENT_AT_SOURCE. HTML from the file is
 * cleaned again in the browser (SNIPPET_SANITIZE_SOURCE); text is set as text.
 *
 * Updates are not announced to screen readers (no aria-live): they happen
 * right after load or at midnight, never in response to the visitor, and the
 * content is reserved in place, so an announcement would only interrupt.
 * See docs/plans/fonts-menus-fields-snippets-templates.md §4.
 */
import type { Block, BlockType } from './types.js';
import { localDate } from './site-fields.js';
import { snippetContentAt, SNIPPET_CONTENT_AT_SOURCE, type SnippetFile } from './snippets.js';
import { liveBaseUrlOf } from './site-field-blocks.js';
import { siteTimeZone } from './site-display-settings.js';

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';
export const SNIPPET_TAGS = ['div', 'section', 'aside', 'p', 'span'] as const;
export type SnippetTag = typeof SNIPPET_TAGS[number];
const SNIPPET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const SNIPPET_BLOCK: BlockType = {
  id: 'core/snippet',
  name: 'snippet',
  label: 'Live snippet',
  icon: 'zap',
  category: 'content',
  container: false,
  schema: [
    { name: 'snippet', type: 'text', label: 'Snippet', required: true, placeholder: 'lunch',
      help: 'The id of one of the site\'s live snippets. Its content is shown as of the latest publication and then updated in the browser.' },
    { name: 'tag', type: 'select', label: 'HTML element', options: [...SNIPPET_TAGS], default: 'div',
      help: 'Use div, section or aside for HTML with paragraphs or lists; p and span suit a line of text.' },
    { name: 'empty_text', type: 'text', label: 'Text when empty', help: 'Shown when the snippet has no content today. Without it the block is hidden.' },
    { name: 'live', type: 'boolean', label: 'Update in the browser', default: true,
      help: 'Fetch the newest content when the page opens, and again at midnight for dated snippets. Off shows the content of the latest publication only.' },
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'text', editor_group: 'content' },
  ],
  template: '<{{=tag}} data-block="snippet"{{{snippet_attrs}}}>{{{snippet_html}}}</{{=tag}}>',
  styles: `
[data-block="snippet"] { margin: 0; }
[data-block="snippet"][data-format="text"] { white-space: pre-line; }
[data-block="snippet"][hidden] { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const SNIPPET_BLOCK_TYPES: readonly BlockType[] = [SNIPPET_BLOCK];

/**
 * The site's snippets as their public files (`snippetFile(snippet,
 * siteTimeZone(settings))`), by id. Undefined or null for an unknown id.
 */
export type SnippetSource = (id: string) => SnippetFile | null | undefined;

/** Builds a SnippetSource from a list of public snippet files. */
export function snippetSourceFrom(files: readonly SnippetFile[]): SnippetSource {
  const byId = new Map(files.map(file => [file.id, file]));
  return id => byId.get(id);
}

export interface PreparedSnippet {
  html: string;
  /** Wrapper attributes, each with a leading space. */
  attrs: string;
  tag: SnippetTag;
}

const escapeText = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const isOff = (value: unknown) => value === false || value === 'false';

/** The snippet id a block names, or '' when it names none (or an invalid one). */
export function snippetBlockId(data: Record<string, unknown> | undefined): string {
  const id = String(data?.snippet ?? '').trim();
  return SNIPPET_ID.test(id) ? id : '';
}

/**
 * What a dated snippet's choice depends on: the content shown, its version
 * and, for dated snippets, the local date. A render cache keeps a page while
 * this is unchanged.
 */
export function snippetReceipt(file: SnippetFile | null | undefined, now: Date): Record<string, unknown> | null {
  if (!file) return null;
  return {
    kind: file.kind, format: file.format, content: snippetContentAt(file, now), updated_at: file.updated_at,
    ...(file.kind === 'dated' ? { date: localDate(now, file.time_zone || siteTimeZone(undefined)).date } : {}),
  };
}

/**
 * The markup of a `core/snippet` block: its content as of `now` (HTML as
 * saved, cleaned again by the page sanitizer; text escaped) and the
 * attributes the browser script reads. Null when the block shows nothing:
 * no content, no empty text and nothing to update.
 */
export function prepareSnippet(data: Record<string, unknown>, options: { source?: SnippetSource; liveBaseUrl?: unknown; now?: Date }): PreparedSnippet | null {
  const id = snippetBlockId(data);
  const tag = SNIPPET_TAGS.find(candidate => candidate === data.tag) ?? 'div';
  const file = id ? options.source?.(id) ?? null : null;
  const base = liveBaseUrlOf(options.liveBaseUrl);
  const live = !!id && !!base && !isOff(data.live);
  const now = options.now ?? new Date();
  const content = file ? snippetContentAt(file, now) : '';
  const emptyText = String(data.empty_text ?? '').trim();
  const html = content ? (file!.format === 'text' ? escapeText(content) : content) : emptyText ? escapeText(emptyText) : '';
  if (!html && !live) return null;
  let attrs = id ? ` data-snippet="${id}"` : '';
  if (file) attrs += ` data-format="${file.format === 'text' ? 'text' : 'html'}"`;
  if (live) attrs += ` data-snippet-src="${escapeText(`${base}/${id}.json`)}"`;
  if (file?.updated_at) attrs += ` data-updated="${escapeText(file.updated_at)}"`;
  if (file?.kind === 'dated') attrs += ` data-snippet-date="${localDate(now, file.time_zone || siteTimeZone(undefined)).date}"`;
  if (!content) attrs += ' data-empty="true"';
  if (live && emptyText) attrs += ` data-empty-text="${escapeText(emptyText)}"`;
  if (!html) attrs += ' hidden';
  return { html, attrs, tag };
}

const walkBlocks = (blocks: readonly Block[], visit: (block: Block) => boolean): boolean =>
  blocks.some(block => visit(block) || walkBlocks(block.children ?? [], visit) || (block.slots ?? []).some(slot => walkBlocks(slot, visit)));

/** Whether the blocks show a snippet that updates in the browser (with a live base URL, the page needs SNIPPET_LIVE_SCRIPT). */
export function usesLiveSnippet(blocks: readonly Block[]): boolean {
  return walkBlocks(blocks, block => block.type === SNIPPET_BLOCK.id && !!snippetBlockId(block.data) && !isOff(block.data?.live));
}

/** Snippet ids that `core/snippet` blocks name and the site does not have ('' for a block that names none). */
export function unknownSnippetReferences(blocks: readonly Block[], known: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  walkBlocks(blocks, block => {
    if (block.type !== SNIPPET_BLOCK.id) return false;
    const id = snippetBlockId(block.data);
    if (!id || !known.has(id)) unknown.add(id ? id : String(block.data?.snippet ?? '').trim());
    return false;
  });
  return [...unknown];
}

/**
 * The browser's cleaner for snippet HTML from a live file, as source: a
 * DOMParser-based allowlist of the tags and attributes rich text uses (p, br,
 * strong, em, b, i, u, s, a, ul, ol, li, h2–h6, blockquote, span, small,
 * mark, img). Other elements are unwrapped (their text stays); script, style,
 * SVG, MathML and other embedded content are dropped with what they hold.
 * No event handlers, no style, links only to http(s), mailto, tel or a
 * relative address, images only from http(s) or a relative address.
 * Plain ES5; needs only DOMParser.
 */
export const SNIPPET_SANITIZE_SOURCE = `function (html) {
  var TAGS = { p: [], br: [], strong: [], em: [], b: [], i: [], u: [], s: [], a: ['href', 'title', 'rel', 'target'], ul: [], ol: [], li: [],
    h2: [], h3: [], h4: [], h5: [], h6: [], blockquote: [], span: [], small: [], mark: [], img: ['src', 'alt', 'width', 'height'] };
  var DROP = { script: 1, style: 1, template: 1, noscript: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1, svg: 1, math: 1,
    textarea: 1, select: 1, option: 1, title: 1, head: 1, link: 1, meta: 1, base: 1, form: 1, input: 1, button: 1, video: 1, audio: 1, canvas: 1 };
  var doc = new DOMParser().parseFromString('<!DOCTYPE html><html><head></head><body>' + String(html) + '</body></html>', 'text/html');
  function url(value, image) {
    var v = String(value).replace(/^[\\u0000-\\u0020]+|[\\u0000-\\u0020]+$/g, '');
    if (!v || /[\\u0000-\\u0020\\u007f\\\\]/.test(v)) return '';
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
    if (!scheme) return v.indexOf('//') === 0 ? '' : v;
    var name = scheme[1].toLowerCase();
    return name === 'http' || name === 'https' || (!image && (name === 'mailto' || name === 'tel')) ? v : '';
  }
  function clean(source, target, depth) {
    if (depth > 64) return;
    for (var node = source.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) { target.appendChild(doc.createTextNode(node.nodeValue)); continue; }
      if (node.nodeType !== 1) continue;
      if (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      var name = String(node.nodeName).toLowerCase();
      if (DROP[name]) continue;
      if (!Object.prototype.hasOwnProperty.call(TAGS, name)) { clean(node, target, depth + 1); continue; }
      var out = doc.createElement(name), allowed = TAGS[name];
      for (var i = 0; i < allowed.length; i++) {
        var value = node.getAttribute(allowed[i]);
        if (value === null) continue;
        if (allowed[i] === 'href' || allowed[i] === 'src') value = url(value, name === 'img');
        else if (allowed[i] === 'target') value = value === '_blank' || value === '_self' ? value : '';
        else if (allowed[i] === 'width' || allowed[i] === 'height') value = /^\\d{1,5}$/.test(value) ? value : '';
        else if (allowed[i] === 'rel') value = value.replace(/[^a-zA-Z0-9 -]/g, '');
        if (value) out.setAttribute(allowed[i], value);
      }
      if (name === 'a' && out.getAttribute('target') === '_blank' && !/(^|\\s)noopener(\\s|$)/.test(out.getAttribute('rel') || '')) {
        out.setAttribute('rel', ((out.getAttribute('rel') || '') + ' noopener').replace(/^\\s+/, ''));
      }
      if (name === 'img' && !out.getAttribute('src')) continue;
      if (name !== 'br' && name !== 'img') clean(node, out, depth + 1);
      target.appendChild(out);
    }
  }
  var root = doc.createElement('div');
  clean(doc.body, root, 0);
  return root.innerHTML;
}`;

/**
 * Shows the newest content of live snippets: fetches each snippet's file once,
 * checks its shape and replaces the block's content unless the published
 * content is still current (same version, same day). Dated snippets are
 * checked again at the next midnight in their time zone while the page stays
 * open, and every snippet after the page was hidden for more than ten
 * minutes. A failed request or an unexpected file keeps what is shown.
 */
export const SNIPPET_LIVE_SCRIPT = `(function () {
  var contentAt = ${SNIPPET_CONTENT_AT_SOURCE};
  var sanitize = ${SNIPPET_SANITIZE_SOURCE};
  var timer = 0, hiddenSince = 0, DEFAULT_ZONE = ${JSON.stringify(siteTimeZone(undefined))};
  function parts(zone, options) {
    var out = {};
    options.timeZone = zone || DEFAULT_ZONE;
    new Intl.DateTimeFormat('en-GB', options).formatToParts(new Date()).forEach(function (part) { out[part.type] = part.value; });
    return out;
  }
  function today(zone) { var p = parts(zone, { year: 'numeric', month: '2-digit', day: '2-digit' }); return p.year + '-' + p.month + '-' + p.day; }
  function untilMidnight(zone) {
    var p = parts(zone, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    return Math.max(60, 86400 - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second))) * 1000 + 5000;
  }
  function valid(file, id) {
    if (!file || typeof file !== 'object' || file.id !== id || (file.format !== 'html' && file.format !== 'text')) return false;
    if (file.time_zone !== undefined && typeof file.time_zone !== 'string') return false;
    if (file.kind === 'html' || file.kind === 'text') return file.content === undefined || typeof file.content === 'string';
    if (file.kind !== 'dated' || !(file.entries instanceof Array) || (file.fallback !== undefined && typeof file.fallback !== 'string')) return false;
    for (var i = 0; i < file.entries.length; i++) if (!file.entries[i] || typeof file.entries[i].content !== 'string') return false;
    return true;
  }
  function apply(node, file) {
    var day = file.kind === 'dated' ? today(file.time_zone) : '';
    if (node.getAttribute('data-updated') === String(file.updated_at) && (!day || node.getAttribute('data-snippet-date') === day)) return;
    var content = contentAt(file, new Date()), fallback = node.getAttribute('data-empty-text') || '';
    if (!content) node.textContent = fallback;
    else if (file.format === 'text') node.textContent = content;
    else node.innerHTML = sanitize(content);
    node.setAttribute('data-format', file.format);
    node.setAttribute('data-updated', String(file.updated_at));
    if (day) node.setAttribute('data-snippet-date', day);
    if (content) node.removeAttribute('data-empty'); else node.setAttribute('data-empty', 'true');
    node.hidden = !content && !fallback;
  }
  function load() {
    var nodes = document.querySelectorAll('[data-snippet-src]'), groups = {}, i;
    for (i = 0; i < nodes.length; i++) {
      var src = nodes[i].getAttribute('data-snippet-src');
      (groups[src] = groups[src] || []).push(nodes[i]);
    }
    Object.keys(groups).forEach(function (src) {
      fetch(src, { credentials: 'omit' }).then(function (response) {
        if (!response.ok) throw new Error('unavailable');
        return response.json();
      }).then(function (file) {
        groups[src].forEach(function (node) {
          if (!valid(file, node.getAttribute('data-snippet'))) return;
          try { apply(node, file); } catch (error) { /* the published content stays */ }
        });
        if (file && file.kind === 'dated' && !timer) timer = setTimeout(function () { timer = 0; load(); }, untilMidnight(file.time_zone));
      })['catch'](function () { /* the published content stays */ });
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') hiddenSince = Date.now();
    else if (hiddenSince && Date.now() - hiddenSince > 600000) { hiddenSince = 0; load(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();`;
