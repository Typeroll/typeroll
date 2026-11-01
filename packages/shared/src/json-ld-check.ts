// Shape checks for explicit page JSON-LD (`Page.json_ld`). Covers the
// properties search engines require for common rich-result types, plus
// dates and URLs that cannot be parsed. Read-only; the result is advice and
// never blocks a publication.

export interface JsonLdIssue {
  /** schema.org `@type` of the object, or `JSON` for unparseable input. */
  type: string;
  code: 'jsonld_malformed' | 'jsonld_missing_property' | 'jsonld_invalid_date' | 'jsonld_invalid_url';
  /** Dotted path inside the JSON-LD. */
  path: string;
  message: string;
}

type Json = Record<string, unknown>;

/** Required properties per type. A nested array means "at least one of". */
const REQUIRED: Record<string, Array<string | string[]>> = {
  FAQPage: ['mainEntity'],
  Article: ['headline'],
  BlogPosting: ['headline'],
  NewsArticle: ['headline'],
  Product: ['name', ['offers', 'review', 'aggregateRating']],
  SoftwareApplication: ['name', ['offers', 'review', 'aggregateRating']],
  WebApplication: ['name', ['offers', 'review', 'aggregateRating']],
  MobileApplication: ['name', ['offers', 'review', 'aggregateRating']],
  Event: ['name', 'startDate', 'location'],
  Recipe: ['name', 'image'],
  Organization: ['name'],
  LocalBusiness: ['name', 'address'],
};

const DATE_KEYS = new Set(['datePublished', 'dateModified', 'dateCreated', 'startDate', 'endDate', 'uploadDate', 'validFrom', 'validThrough', 'priceValidUntil']);
const URL_KEYS = new Set(['url', 'image', 'logo', 'sameAs', 'contentUrl', 'thumbnailUrl', 'embedUrl', 'downloadUrl', 'installUrl']);

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function types(node: Json): string[] {
  const value = node['@type'];
  return (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return false;
  return !Number.isNaN(Date.parse(value.trim()));
}

function validUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true; // resolved against the page URL on output
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch { return false; }
}

/** Check one page's `json_ld` string. Empty input has no issues. */
export function checkJsonLd(input: unknown): JsonLdIssue[] {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim())) return [];
  let data: unknown = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); }
    catch { return [{ type: 'JSON', code: 'jsonld_malformed', path: '', message: 'The JSON-LD is not valid JSON.' }]; }
  }
  const issues: JsonLdIssue[] = [];
  const roots = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as Json)['@graph']) ? (data as Json)['@graph'] as unknown[] : [data];
  if (!roots.every(root => root && typeof root === 'object')) {
    return [{ type: 'JSON', code: 'jsonld_malformed', path: '', message: 'JSON-LD must be an object or an array of objects.' }];
  }

  const visit = (node: unknown, path: string, owner: string) => {
    if (Array.isArray(node)) { node.forEach((item, i) => visit(item, `${path}[${i}]`, owner)); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Json;
    const nodeTypes = types(obj);
    const label = nodeTypes[0] ?? owner;
    for (const type of nodeTypes) {
      for (const rule of REQUIRED[type] ?? []) {
        const options = Array.isArray(rule) ? rule : [rule];
        if (options.some(key => present(obj[key]))) continue;
        issues.push({ type, code: 'jsonld_missing_property', path: path || '.',
          message: options.length > 1 ? `${type} needs one of ${options.join(', ')}.` : `${type} is missing ${options[0]}.` });
      }
      if (type === 'FAQPage' && Array.isArray(obj.mainEntity)) {
        obj.mainEntity.forEach((question, i) => {
          const q = (question ?? {}) as Json;
          const answer = (q.acceptedAnswer ?? {}) as Json;
          if (!present(q.name) || !present(answer.text)) {
            issues.push({ type, code: 'jsonld_missing_property', path: `${path ? `${path}.` : ''}mainEntity[${i}]`, message: 'Each FAQ question needs a name and acceptedAnswer.text.' });
          }
        });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      const at = path ? `${path}.${key}` : key;
      if (DATE_KEYS.has(key) && typeof value === 'string' && !validDate(value)) {
        issues.push({ type: label, code: 'jsonld_invalid_date', path: at, message: `${key} is not an ISO 8601 date: ${value.slice(0, 80)}` });
      } else if (URL_KEYS.has(key)) {
        for (const [i, entry] of (Array.isArray(value) ? value : [value]).entries()) {
          if (typeof entry === 'string' && !validUrl(entry)) {
            issues.push({ type: label, code: 'jsonld_invalid_url', path: Array.isArray(value) ? `${at}[${i}]` : at, message: `${key} is not an http(s) URL: ${entry.slice(0, 120)}` });
          }
        }
      }
      if (value && typeof value === 'object') visit(value, at, label);
    }
  };
  roots.forEach((root, i) => visit(root, roots.length > 1 ? `[${i}]` : '', 'Thing'));
  return issues;
}
