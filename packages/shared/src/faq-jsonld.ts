// FAQPage structured data derived from the Accordion blocks a page renders.
//
// Only rendered HTML is read, so an accordion that is not published (a hidden
// condition branch, a render version without items) never reaches the
// schema. An accordion counts as questions and answers only when every item
// has a title ending in a question mark and a nonempty answer; anything else,
// such as a product specification list, is left alone.

const QUESTION_END = /[?？؟;՞]\s*$/u;
const ACCORDION_OPEN = /<div\b[^>]*\bdata-block="accordion"[^>]*>/gi;
const DETAILS = /^\s*<details\b[^>]*>([\s\S]*?)<\/details>/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Math.min(parseInt(lower.slice(2), 16), 0x10ffff));
    if (lower.startsWith('#')) return String.fromCodePoint(Math.min(Number(lower.slice(1)), 0x10ffff));
    return ENTITIES[lower] ?? match;
  });
}

/** Visible text of an HTML fragment: tags removed, block boundaries kept as spaces. */
function htmlToPlainText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FaqItem { question: string; answer: string }

/** Question and answer pairs from every qualifying Accordion block in the HTML. */
export function faqItemsFromHtml(html: string | null | undefined): FaqItem[] {
  if (!html || !html.includes('data-block="accordion"')) return [];
  const items: FaqItem[] = [];
  const seen = new Set<string>();
  for (const open of html.matchAll(ACCORDION_OPEN)) {
    let rest = html.slice(open.index! + open[0].length);
    const block: FaqItem[] = [];
    let qualifies = true;
    for (let match = rest.match(DETAILS); match; match = rest.match(DETAILS)) {
      rest = rest.slice(match[0].length);
      const inner = match[1]!;
      const summary = inner.match(/^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*)$/i);
      // A nested <details> cannot be split reliably with a pattern; skip the block.
      if (!summary || inner.includes('<details')) { qualifies = false; break; }
      const question = htmlToPlainText(summary[1]!);
      const answer = htmlToPlainText(summary[2]!);
      if (!question || !answer || !QUESTION_END.test(question)) { qualifies = false; break; }
      block.push({ question, answer });
    }
    if (!qualifies) continue;
    for (const item of block) {
      if (seen.has(item.question)) continue;
      seen.add(item.question);
      items.push(item);
    }
  }
  return items;
}

/** A schema.org FAQPage for the page's rendered accordions, or null when none qualify. */
export function faqPageJsonLd(html: string | null | undefined): string | null {
  const items = faqItemsFromHtml(html);
  if (!items.length) return null;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  });
}

function declaresType(value: unknown, type: string, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(entry => declaresType(entry, type, depth + 1));
  const record = value as Record<string, unknown>;
  const declared = record['@type'];
  if (declared === type || (Array.isArray(declared) && declared.includes(type))) return true;
  return declaresType(record['@graph'], type, depth + 1);
}

/** True when any of the serialized JSON-LD documents already declares the schema.org type. */
export function jsonLdDeclaresType(documents: Array<string | null | undefined>, type: string): boolean {
  return documents.some(document => {
    if (!document) return false;
    try { return declaresType(JSON.parse(document), type); }
    catch { return document.includes(`"${type}"`); }
  });
}
