// Schema.org JSON-LD builders for Page.json_ld: FAQPage, Recipe and Event.
//
// One implementation for every caller. The MCP tools (tools/structured-data.ts)
// and the portal's built-in AI chat (portal/src/lib/anthropic.ts, imported as
// @typeroll/mcp-server/structured-data) both validate input with these zod
// shapes and build JSON-LD with these functions, so the two cannot drift. It
// lives in this package rather than @typeroll/shared because the standalone
// MCP package is published without @typeroll/shared, while the portal already
// depends on this package.
//
// mergeJsonLd() adds the new node to whatever the page already carries: a node
// of the same @type is replaced (re-running a tool updates it), other nodes are
// kept in an @graph, so an FAQ added later does not erase a LocalBusiness.

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonLdNode = Record<string, unknown>;
export type StructuredDataKind = 'faq' | 'recipe' | 'event';

/** Invalid input or an unusable existing json_ld; `issues` name the field. */
export class StructuredDataError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid structured data: ${issues.join('; ')}`);
    this.name = 'StructuredDataError';
  }
}

const text = (max: number) => z.string().trim().min(1, 'Must not be empty.').max(max);
const httpUrl = z.string().trim().max(2048).url('Use an absolute http(s) URL.')
  .refine((value) => /^https?:\/\//i.test(value), 'Use an absolute http(s) URL.');

const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/;
const duration = z.string().trim().regex(ISO_DURATION, 'Use an ISO 8601 duration such as PT30M or PT1H15M.');

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;
function realDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}
const isoDate = z.string().trim().refine(realDate, 'Use an ISO 8601 date or date-time, e.g. 2026-06-12 or 2026-06-12T19:00:00+02:00.');
const hasTime = (value: string) => value.includes('T');
const hasOffset = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value);

/** Input fields of add_faq_schema (besides page_id). */
export const faqSchemaShape = {
  items: z.array(z.object({
    question: text(500),
    answer: text(5000).describe('Plain text or simple HTML, exactly as the page shows it.'),
  }).strict()).min(1, 'Add at least one question.').max(100)
    .describe('The questions and answers the page itself shows, in page order.'),
};

/** Input fields of add_recipe_schema (besides page_id). */
export const recipeSchemaShape = {
  name: text(200),
  description: text(1000).optional(),
  image_url: httpUrl.optional().describe('Absolute image URL, e.g. the page\'s CDN image. Google needs an image for recipe rich results.'),
  author: text(200).optional(),
  prep_time: duration.optional().describe('ISO 8601 duration, e.g. PT30M.'),
  cook_time: duration.optional().describe('ISO 8601 duration, e.g. PT1H.'),
  total_time: duration.optional().describe('ISO 8601 duration, e.g. PT1H30M.'),
  recipe_yield: text(100).optional().describe('e.g. "4 servings".'),
  ingredients: z.array(text(500)).min(1, 'Add at least one ingredient.').max(100),
  instructions: z.array(text(2000)).min(1, 'Add at least one step.').max(100).describe('One entry per step, in order.'),
};

/** Input fields of add_event_schema (besides page_id). */
export const eventSchemaShape = {
  name: text(200),
  description: text(1000).optional(),
  start_date: isoDate.describe('ISO 8601, e.g. 2026-06-12T19:00:00+02:00. Include the UTC offset.'),
  end_date: isoDate.optional().describe('ISO 8601; not before start_date.'),
  location_name: text(200).optional(),
  location_address: text(500).optional(),
  image_url: httpUrl.optional(),
  offers_url: httpUrl.optional().describe('Ticket URL.'),
  offers_price: z.union([z.number().nonnegative(), z.string().trim().regex(/^\d+(?:\.\d+)?$/, 'Use a number such as 250 or 19.95.')])
    .optional().describe('Ticket price as a number; 0 for a free event. Needs offers_currency.'),
  offers_currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use an ISO 4217 code such as EUR or SEK.').optional()
    .describe('ISO 4217, e.g. EUR.'),
};

export type FaqSchemaInput = z.infer<z.ZodObject<typeof faqSchemaShape>>;
export type RecipeSchemaInput = z.infer<z.ZodObject<typeof recipeSchemaShape>>;
export type EventSchemaInput = z.infer<z.ZodObject<typeof eventSchemaShape>>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new StructuredDataError(result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
}

const CONTEXT = 'https://schema.org';

export function buildFaqJsonLd(input: unknown): { node: JsonLdNode; warnings: string[] } {
  const { items } = parse(z.object(faqSchemaShape), input);
  return {
    node: {
      '@context': CONTEXT,
      '@type': 'FAQPage',
      mainEntity: items.map((it) => ({
        '@type': 'Question',
        name: it.question,
        acceptedAnswer: { '@type': 'Answer', text: it.answer },
      })),
    },
    warnings: [],
  };
}

export function buildRecipeJsonLd(input: unknown): { node: JsonLdNode; warnings: string[] } {
  const r = parse(z.object(recipeSchemaShape), input);
  const node: JsonLdNode = { '@context': CONTEXT, '@type': 'Recipe', name: r.name };
  if (r.description) node.description = r.description;
  if (r.image_url) node.image = r.image_url;
  if (r.author) node.author = { '@type': 'Person', name: r.author };
  if (r.prep_time) node.prepTime = r.prep_time;
  if (r.cook_time) node.cookTime = r.cook_time;
  if (r.total_time) node.totalTime = r.total_time;
  if (r.recipe_yield) node.recipeYield = r.recipe_yield;
  node.recipeIngredient = r.ingredients;
  node.recipeInstructions = r.instructions.map((step, i) => ({ '@type': 'HowToStep', position: i + 1, text: step }));
  const warnings = r.image_url ? [] : ['No image_url: Google shows recipe rich results only for recipes with an image.'];
  return { node, warnings };
}

export function buildEventJsonLd(input: unknown): { node: JsonLdNode; warnings: string[] } {
  const e = parse(z.object(eventSchemaShape).superRefine((v, ctx) => {
    if (v.offers_price !== undefined && !v.offers_currency) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['offers_currency'], message: 'Required with offers_price.' });
    }
    if (v.end_date && hasTime(v.start_date) === hasTime(v.end_date) && hasOffset(v.start_date) === hasOffset(v.end_date)
      && Date.parse(v.end_date) < Date.parse(v.start_date)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_date'], message: 'Must not be before start_date.' });
    }
  }), input);
  const node: JsonLdNode = { '@context': CONTEXT, '@type': 'Event', name: e.name, startDate: e.start_date };
  if (e.end_date) node.endDate = e.end_date;
  if (e.description) node.description = e.description;
  if (e.image_url) node.image = e.image_url;
  if (e.location_name || e.location_address) {
    node.location = {
      '@type': 'Place',
      ...(e.location_name ? { name: e.location_name } : {}),
      ...(e.location_address ? { address: e.location_address } : {}),
    };
  }
  if (e.offers_url || e.offers_price !== undefined) {
    node.offers = {
      '@type': 'Offer',
      ...(e.offers_url ? { url: e.offers_url } : {}),
      ...(e.offers_price !== undefined ? { price: String(e.offers_price) } : {}),
      ...(e.offers_currency ? { priceCurrency: e.offers_currency.toUpperCase() } : {}),
      availability: 'https://schema.org/InStock',
    };
  }
  const warnings: string[] = [];
  if (hasTime(e.start_date) && !hasOffset(e.start_date)) warnings.push('start_date has no UTC offset; add one (e.g. +02:00) so search engines show the right local time.');
  if (!node.location) warnings.push('No location: Google shows event rich results only for events with a location.');
  return { node, warnings };
}

/** The three page structured-data helpers, keyed by kind. */
export const STRUCTURED_DATA = {
  faq: { tool: 'add_faq_schema', type: 'FAQPage', shape: faqSchemaShape, build: buildFaqJsonLd },
  recipe: { tool: 'add_recipe_schema', type: 'Recipe', shape: recipeSchemaShape, build: buildRecipeJsonLd },
  event: { tool: 'add_event_schema', type: 'Event', shape: eventSchemaShape, build: buildEventJsonLd },
} as const;

/**
 * JSON Schema of a helper's input including `page_id`, for tool definitions
 * outside MCP (the portal chat passes it to the model as input_schema).
 */
export function structuredDataInputSchema(kind: StructuredDataKind): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const schema = (zodToJsonSchema as (schema: unknown, options: { $refStrategy: 'none' }) => Record<string, unknown>)(
    z.object({ page_id: z.string().min(1), ...STRUCTURED_DATA[kind].shape }), { $refStrategy: 'none' });
  const { $schema: _schema, ...rest } = schema;
  return rest as { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

function typesOf(node: JsonLdNode): string[] {
  const t = node['@type'];
  return Array.isArray(t) ? t.map(String) : t == null ? [] : [String(t)];
}

/**
 * Combine a page's existing json_ld string with a new node. Nodes of the same
 * @type are replaced; other nodes are kept. Returns the json_ld string to
 * store. An existing value that is not a JSON object/array is refused rather
 * than silently overwritten.
 */
export function mergeJsonLd(existing: string | null | undefined, node: JsonLdNode): { json_ld: string; replaced: number; kept: number } {
  const raw = typeof existing === 'string' ? existing.trim() : '';
  let nodes: JsonLdNode[] = [];
  if (raw) {
    let data: unknown;
    try { data = JSON.parse(raw); } catch {
      throw new StructuredDataError(['json_ld: the page\'s existing json_ld is not valid JSON. Read the page, then fix or clear json_ld with update_page before adding structured data.']);
    }
    const list = Array.isArray(data) ? data
      : data && typeof data === 'object' && Array.isArray((data as JsonLdNode)['@graph']) ? (data as JsonLdNode)['@graph'] as unknown[]
        : [data];
    if (!list.every((n) => n && typeof n === 'object' && !Array.isArray(n))) {
      throw new StructuredDataError(['json_ld: the page\'s existing json_ld is not a JSON-LD object or list of objects. Fix or clear it with update_page first.']);
    }
    nodes = list as JsonLdNode[];
  }
  const newTypes = typesOf(node);
  const kept = nodes.filter((n) => !typesOf(n).some((t) => newTypes.includes(t)));
  const replaced = nodes.length - kept.length;
  if (!kept.length) return { json_ld: JSON.stringify(node), replaced, kept: 0 };
  const strip = ({ '@context': _context, ...rest }: JsonLdNode) => rest;
  return {
    json_ld: JSON.stringify({ '@context': CONTEXT, '@graph': [...kept.map(strip), strip(node)] }),
    replaced,
    kept: kept.length,
  };
}
