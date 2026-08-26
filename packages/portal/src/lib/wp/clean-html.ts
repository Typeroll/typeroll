// WordPress HTML → simple semantic HTML.
//
// The goal: produce markup that looks like a human wrote it, not what a page
// builder spat out. We strip the entire WordPress / Elementor / Breakdance
// class soup, remove inline styles and tracking IDs, and unwrap pointless
// nested divs. We keep semantic tags (sections, headings, lists, blockquotes,
// images), keep useful attributes (href, src, alt), and rewrite media URLs
// to the customer's new CDN.

import sanitizeHtml from 'sanitize-html';

export interface CleanOptions {
  /** Map of old WP media URL → new CDN URL. Applied to <img src> and srcset. */
  mediaMap?: Map<string, string>;
  /** Source site origin (e.g. "https://oldsite.com") — used to rewrite internal links to relative paths. */
  sourceOrigin?: string;
  /** Strip empty paragraphs and trim leading/trailing whitespace. */
  collapseWhitespace?: boolean;
}

// Tags we keep verbatim. Everything not in this list either gets unwrapped
// (its children survive) or removed entirely.
const SEMANTIC_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 'small', 'mark',
  's', 'del', 'ins', 'sub', 'sup',
  'a', 'br', 'hr',
  'img', 'figure', 'figcaption', 'picture',
  'video', 'audio', 'source',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'span',
  'iframe', // for video embeds we want to preserve
  'time',
]);

// Tags we remove entirely (along with their children). NOTE: this list must
// NOT include any tag in SEMANTIC_TAGS — sanitize-html already removes tags
// not in its allowedTags list, and this post-pass is only a belt-and-braces
// fallback for malformed input. Including a tag in both lists silently kills
// it after sanitize-html allowed it through.
const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'object', 'embed',
  'form', 'input', 'textarea', 'select', 'button', 'label', 'fieldset',
  'svg', // usually decorative builder icons; AI can re-add real ones
  'meta', 'link', 'head', 'title',
]);

// Attributes we keep. Everything else is dropped.
const KEEP_ATTRS: Record<string, string[]> = {
  '*': [], // no global keep — be explicit per tag
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading'],
  source: ['src', 'srcset', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'width', 'height'],
  audio: ['src', 'controls'],
  iframe: ['src', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'loading'],
  table: [],
  th: ['scope'],
  td: ['colspan', 'rowspan'],
  time: ['datetime'],
  blockquote: ['cite'],
  q: ['cite'],
};

export function cleanWordPressHtml(input: string, opts: CleanOptions = {}): string {
  if (!input) return '';

  // 1. Strip WP-specific block comments — they pad markup heavily and add
  //    nothing once we're no longer inside the WP editor.
  let html = input.replace(/<!--\s*\/?wp:[^>]*-->/g, '');

  // 2. Strip generic HTML comments.
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Run through sanitize-html with our whitelist. Order: strip dangerous
  //    tags entirely, keep semantic tags with only the attrs we want.
  const allowedAttributes: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(KEEP_ATTRS)) allowedAttributes[k] = v;

  html = sanitizeHtml(html, {
    allowedTags: Array.from(SEMANTIC_TAGS),
    allowedAttributes,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href;
        if (href && opts.sourceOrigin && href.startsWith(opts.sourceOrigin)) {
          attribs.href = href.slice(opts.sourceOrigin.length) || '/';
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        const src = attribs.src;
        if (src && opts.mediaMap?.has(src)) {
          attribs.src = opts.mediaMap.get(src)!;
        }
        if (attribs.srcset && opts.mediaMap) {
          attribs.srcset = attribs.srcset
            .split(',')
            .map((part) => {
              const [url, size] = part.trim().split(/\s+/);
              const mapped = opts.mediaMap?.get(url);
              return mapped ? `${mapped} ${size ?? ''}`.trim() : part.trim();
            })
            .join(', ');
        }
        // Add loading=lazy unless first image (caller can override).
        if (!attribs.loading) attribs.loading = 'lazy';
        return { tagName, attribs };
      },
      // Tags with no attribute whitelist still keep their content; this
      // ensures the tag survives even without attributes.
    },
    // sanitize-html removes <span> by default if it has no attrs; we want it
    // either way, then post-process to collapse pointless ones.
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
    parser: { lowerCaseAttributeNames: true },
  });

  // 4. Strip remaining tags that should have been removed but might survive
  //    when the input is malformed.
  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    html = html.replace(re, '');
    const selfClose = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
    html = html.replace(selfClose, '');
  }

  // 5. Unwrap divs and spans with no attributes (pure structural noise).
  let prev: string;
  do {
    prev = html;
    html = html.replace(/<(div|span)>\s*([\s\S]*?)\s*<\/\1>/gi, '$2');
  } while (html !== prev);

  // 6. Strip empty paragraphs.
  if (opts.collapseWhitespace !== false) {
    html = html.replace(/<p>\s*(?:&nbsp;| )?\s*<\/p>/gi, '');
    html = html.replace(/\n{3,}/g, '\n\n');
    html = html.trim();
  }

  // 7. Final pass: remove leading/trailing whitespace inside block tags.
  html = html.replace(/>\s+</g, '><');

  return html;
}

/**
 * Reformat the cleaned HTML so source diffs are readable.
 * Inserts newlines between block-level tags. Cosmetic only.
 */
export function prettyPrint(html: string): string {
  const blockTags = ['section', 'article', 'header', 'footer', 'main', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tr', 'figure', 'div'];
  let out = html;
  for (const t of blockTags) {
    out = out.replace(new RegExp(`<${t}(\\s|>)`, 'g'), `\n<${t}$1`);
    out = out.replace(new RegExp(`</${t}>`, 'g'), `</${t}>\n`);
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}
