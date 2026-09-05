import { DomUtils, parseDocument } from 'htmlparser2';
import { decodeHTML } from 'entities';

/**
 * Convert a WordPress field whose Typeroll contract is plain text.
 *
 * WordPress REST and SEO plugins commonly return a mixture of markup and
 * encoded entities. Decode exactly one layer before removing markup: repeated
 * decoding could turn intentionally escaped text into active markup.
 */
export function normalizeWordPressPlainText(value: string): string {
  const decoded = decodeHTML(value);
  return DomUtils.textContent(parseDocument(decoded, { decodeEntities: false })).trim();
}
