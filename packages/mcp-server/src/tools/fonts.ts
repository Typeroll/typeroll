// Fonts: find a family, choose a family per role, and add font files to the
// site's Fonts library. Each tool maps onto the v1 API: search_fonts reads
// /fonts/catalog, set_site_fonts patches settings.fonts (with `version`, like
// update_site_settings), upload_font posts to /fonts.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef } from './helpers.js';

const ROLES =
  'A site chooses one family per role: heading (H1–H6), body (running text), mono (code; no webfont unless set), display (large headings and heroes; unset uses the heading family) and accent (eyebrows and quotes; unset uses the body family). ' +
  'Display and accent take effect from render version 15. Styles and blocks choose a role, never a family, so changing a role restyles every style and block that uses it, and templates follow the site they are inserted into.';

const SOURCES =
  'Where a family loads from, in order: the site\'s Fonts library (uploaded files, upload_font), a font service in fonts.services (Adobe Fonts kit, Bunny Fonts or Fontshare stylesheet, loaded from their CDN), "system" (the device\'s own fonts, no download), and otherwise Google Fonts. ' +
  'Google families are self-hosted by default (fonts.delivery "self_hosted": the files are copied into the published site, no request to Google), or loaded from the Google Fonts CDN with delivery "google".';

const role = z.string().min(1).max(80).describe('A family name, as search_fonts lists it, or "system".');
const clearableRole = role.nullable().optional();
const weights = z.array(z.number().int().min(100).max(900).multipleOf(100)).max(9);
const service = z.union([
  z.object({ provider: z.literal('adobe'), kit: z.string().describe('The Adobe Fonts web project ID from the embed code https://use.typekit.net/<kit>.css.'), families: z.array(z.string()).max(40).describe('The family names the kit defines (its CSS font-family names, e.g. "brand-sans").') }).strict(),
  z.object({ provider: z.enum(['bunny', 'fontshare']), url: z.string().describe('The stylesheet URL: https://fonts.bunny.net/css?family=… or https://api.fontshare.com/v2/css?f[]=…'), families: z.array(z.string()).max(40) }).strict(),
]);

export const fontTools: ToolDef[] = [
  {
    name: 'search_fonts',
    description:
      'Search the font catalog (250 open-licence Google Fonts families with their weights, italics, variable weight axis and extended Latin support) and the site\'s own families: uploaded files (`library`) and font services (`services`), matching the same query. ' +
      'Exact names rank first, then names starting with the query. Use it before set_site_fonts to check a family exists and has the weights the design needs. Swedish, Norwegian, Danish, Finnish and German are covered by every catalog family; latin_ext adds Polish, Czech, Turkish and more. ' + SOURCES,
    inputSchema: {
      query: z.string().max(80).optional().describe('Part of a family name, e.g. "grotesk" or "Playfair".'),
      category: z.union([z.enum(['sans', 'serif', 'display', 'handwriting', 'mono']), z.array(z.enum(['sans', 'serif', 'display', 'handwriting', 'mono'])).max(5)]).optional(),
      variable: z.boolean().optional().describe('Only variable families (one file covers every weight).'),
      italic: z.boolean().optional().describe('Only families with italics.'),
      latin_ext: z.boolean().optional().describe('Only families with the extended Latin subset.'),
      limit: z.number().int().min(1).max(250).optional().describe('Catalog results to return (default 50).'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const flag = (value: boolean | undefined) => value === undefined ? undefined : String(value);
      return ok(await client.get(siteId, 'fonts/catalog', {
        query: args.query,
        category: Array.isArray(args.category) ? args.category.join(',') : args.category,
        variable: flag(args.variable), italic: flag(args.italic), latin_ext: flag(args.latin_ext), limit: args.limit,
      }));
    }),
  },
  {
    name: 'set_site_fonts',
    description:
      'Choose the site\'s fonts. ' + ROLES + ' ' +
      'From render version 15 a publication loads only the weights and italics the site uses (from its styles, block weight settings and bold or italic text), so there is nothing to list for normal use; `load` adds extra weights per role, for example for custom CSS: { body: { weights: [300], italic: [400] } }. Before version 15 every family loads 400–700. ' +
      SOURCES + ' ' +
      'Only the keys you pass change; null clears mono, display, accent, load, delivery or services. Requires admin permission, like update_site_settings. Pass `version` to change a branch instead of main. ' +
      'The response warns about a family that is not in the catalog, the Fonts library or a font service. Check the result with get_preview_link before publishing.',
    inputSchema: {
      version: versionParam,
      heading: role.optional(),
      body: role.optional(),
      mono: clearableRole.describe('Code and preformatted text. Without it code uses the system monospace stack; null clears.'),
      display: clearableRole.describe('Large headings and heroes (render version 15). null uses the heading family.'),
      accent: clearableRole.describe('Eyebrows and quotes (render version 15). null uses the body family.'),
      load: z.record(z.enum(['heading', 'body', 'mono', 'display', 'accent']), z.object({ weights: weights.optional(), italic: weights.optional() }).strict()).nullable().optional()
        .describe('Extra weights (and italic weights) to load per role beyond those in use, e.g. { "heading": { "weights": [800] } }. null clears.'),
      delivery: z.enum(['self_hosted', 'google']).nullable().optional().describe('Google Fonts delivery: self_hosted (default, files copied into the site) or google (Google Fonts CDN). Uploaded and service fonts are unaffected.'),
      services: z.array(service).max(4).nullable().optional()
        .describe('Font services whose stylesheet loads from their CDN; replaces the list. Adobe Fonts\' licence does not allow self-hosting, so a kit always loads from Adobe (the visitor\'s browser contacts Adobe; mention it in the privacy policy). null clears.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...fonts } = args as Record<string, unknown> & { version?: string };
      const patch = Object.fromEntries(Object.entries(fonts).filter(([, value]) => value !== undefined));
      if (!Object.keys(patch).length) throw new Error('No fonts supplied. Pass at least one role (heading, body, mono, display, accent), load, delivery or services.');
      return ok(await client.patch(siteId, 'settings', { fonts: patch }, version ? { version } : undefined));
    }),
  },
  {
    name: 'upload_font',
    description:
      'Add a font file to the site\'s Fonts library (not the media library), so a role can use its family with set_site_fonts. WOFF2, WOFF, TTF or OTF up to 10 MB, one font per file (no .ttc collections); anything but WOFF2 is converted to WOFF2 and the original kept. ' +
      'Family, weight and style default from the file; pass them to correct the file\'s names. A variable font covers a weight range ("100-900"). Upload one file per style (regular, italic) and, for static fonts, per weight. ' +
      'licence_confirmed must be true and means the user confirmed the font\'s licence allows use on this website (a webfont or web licence; most desktop licences do not include it). Ask the user before uploading; never assume it. It is stored with who confirmed it and when. ' +
      'Send the file as data_base64 with filename, or as source_url (https; downloaded by Typeroll). Requires admin permission. The library belongs to the site, not to a branch. ' +
      'Adobe Fonts cannot be uploaded (its licence does not allow self-hosting): add the kit with set_site_fonts services instead.',
    inputSchema: {
      filename: z.string().max(255).optional().describe('The file name, e.g. "BrandSans-Regular.woff2". Required with data_base64.'),
      data_base64: z.string().optional().describe('The file bytes, base64-encoded (a data: URL prefix is allowed).'),
      source_url: z.string().optional().describe('An https:// URL to download the file from, instead of data_base64.'),
      family: z.string().max(80).optional().describe('The family name the roles use. Defaults to the name in the file.'),
      weight: z.union([z.number().int().min(100).max(900), z.string()]).optional().describe('400, or a range such as "100-900" for a variable font. Defaults to the file\'s weight.'),
      style: z.enum(['normal', 'italic']).optional().describe('Defaults to the file\'s style.'),
      category: z.enum(['sans', 'serif']).optional().describe('Chooses the metric-matched fallback shown while the font loads (Arial or Times New Roman). Defaults to sans.'),
      licence_confirmed: z.literal(true).describe('true: the user confirmed the licence allows using this font on this website.'),
      licence_note: z.string().max(500).optional().describe('Where the licence comes from, e.g. "Web licence, order 1234".'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const body = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
      return ok(await client.post(siteId, 'fonts', body));
    }),
  },
];
