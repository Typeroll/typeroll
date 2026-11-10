// Plain text of an HTML fragment, for structured data that wants words only
// (Article articleBody, FAQ answers). Elements that are code or decoration
// rather than readable text — <style>, <script>, <noscript>, <template> and
// inline <svg> — are removed with their content, so CSS or script source can
// never leak into the text.

import { decodeHtmlEntities } from './page-markdown.js';

const NON_TEXT = 'script|style|noscript|template|svg';
// The tag name ends at whitespace, `/` or `>`, so <svg-icon> is not <svg>.
const SELF_CLOSING_NON_TEXT = new RegExp(`<(?:${NON_TEXT})(?=[\\s/>])[^>]*\\/>`, 'gi');
const NON_TEXT_ELEMENT = new RegExp(`<(${NON_TEXT})(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
/** An unclosed one hides everything after it from a browser, too. */
const UNCLOSED_NON_TEXT = new RegExp(`<(?:${NON_TEXT})(?=[\\s/>])[\\s\\S]*$`, 'i');
const BLOCK_BOUNDARY = /<br\b[^>]*>|<\/?(?:p|div|section|article|header|footer|main|aside|nav|figure|figcaption|blockquote|pre|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|h[1-6]|hr|details|summary)\b[^>]*>/gi;

/** Visible text of an HTML fragment: non-text elements and tags removed, block boundaries kept as spaces. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(SELF_CLOSING_NON_TEXT, ' ')
    .replace(NON_TEXT_ELEMENT, ' ')
    .replace(UNCLOSED_NON_TEXT, ' ')
    .replace(BLOCK_BOUNDARY, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
}
