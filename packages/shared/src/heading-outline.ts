export interface HeadingOutlineEntry {
  level: 2 | 3 | 4;
  id: string;
  text: string;
}

export interface PreparedHeadingOutline {
  html: string;
  headings: HeadingOutlineEntry[];
}

const HEADING_RE = /<h([2-4])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
const ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function decodeHeadingText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, raw: string) => {
      const point = Number.parseInt(raw, 16);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/&#(\d+);/g, (_match, raw: string) => {
      const point = Number.parseInt(raw, 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name: string) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[name.toLowerCase()] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function replaceOrAppendId(attrs: string, id: string): string {
  const escaped = id.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  if (ID_RE.test(attrs)) return attrs.replace(ID_RE, `id="${escaped}"`);
  return `${attrs} id="${escaped}"`;
}

/**
 * Materialize stable heading ids and an outline from one sanitized rich-text
 * field. Existing unique ids are preserved; missing or duplicate ids receive
 * deterministic suffixes. The caller still sanitizes the returned HTML.
 */
export function prepareHeadingOutline(html: string): PreparedHeadingOutline {
  const used = new Set<string>();
  const headings: HeadingOutlineEntry[] = [];
  const prepared = html.replace(HEADING_RE, (_match, rawLevel: string, rawAttrs: string, inner: string) => {
    const level = Number(rawLevel) as 2 | 3 | 4;
    const text = decodeHeadingText(inner);
    const idMatch = rawAttrs.match(ID_RE);
    const requested = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? '').trim();
    const id = uniqueId(requested || headingSlug(text), used);
    headings.push({ level, id, text: text || `Section ${headings.length + 1}` });
    return `<h${level}${replaceOrAppendId(rawAttrs, id)}>${inner}</h${level}>`;
  });
  return { html: prepared, headings };
}
