// Typeroll packages (.typeroll): export part of a site, or a whole site, as
// one portable file, and inspect or import a package into a site. Each tool
// maps onto /api/v1/sites/{siteId}/packages/*.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef } from './helpers.js';

const v = (version?: string) => (version ? { version } : undefined);
const ids = z.union([z.literal('all'), z.array(z.string().min(1).max(100)).max(500)]);

const FORMAT =
  'A package belongs to no organization: it carries no organization or site ids, and its media files (and font files the author may pass on) travel inside it, so anyone can import it into their own site, for example a template pack bought from someone else. ' +
  'Media references in content become `typeroll-media:<id>` tokens and app blocks are named by their app, not the site\'s installation.';

const STYLES =
  'Styles are never mapped to the site\'s "nearest" styles: every style the imported content uses is created on the site. A style is reused only when the site has one with the same id and the same definition; a differing one is created under a new id (hero-2, named "Hero (imported)") and the imported content is rewritten to it. Block types, templates, global blocks, menus and pages that collide get new ids the same way.';

const DESIGN =
  'options.design: "content" (default: the blocks and the styles they use), "styles" (also the package\'s other class styles) or "full" (also the element styles body/h1–h6/link replacing the site\'s, colours, typography, scales, content widths and font roles; requires admin). ' +
  'Font files in the package are added to the Fonts library only with options.font_licence_confirmed: true, which means the user confirmed the font licence allows use on this site; ask the user, never assume it. options.fonts: false leaves the fonts out. Adobe Fonts, Bunny Fonts and Fontshare kits never transfer: only the family names, with a warning.';

const source = {
  data_base64: z.string().optional().describe('The .typeroll file, base64-encoded (at most 32 MB). Send this or source_url.'),
  source_url: z.string().optional().describe('An https:// address to download the package from (up to 200 MB), instead of data_base64.'),
};
const options = z.object({
  design: z.enum(['content', 'styles', 'full']).optional(),
  fonts: z.boolean().optional().describe('With design "full": import the package\'s font roles and font files (default true).'),
  only: z.array(z.string()).max(5000).optional().describe('Only these entries, e.g. ["block_templates.hero", "menus.main"]; all when absent.'),
  font_licence_confirmed: z.boolean().optional().describe('true: the user confirmed the licence of the package\'s font files allows use on this site.'),
}).strict();

const body = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key, value]) => key !== 'version' && value !== undefined));

export const packageTools: ToolDef[] = [
  {
    name: 'export_package',
    description:
      'Export part of the site, or the whole site, as a Typeroll package (.typeroll) and get a signed download address valid for one hour (download_url, filename, bytes, sha256, expires_at, warnings). ' + FORMAT + ' ' +
      'selection.kind "collection" holds what you choose: block_templates, page_templates, global_blocks (free global blocks) and block_types as id lists or "all", styles "used" (default) or "all", design (colours, typography, scales, content widths, font roles and element styles), menus, site_fields (definitions) and demo_media (media ids to mark as demo content the buyer replaces). Global blocks, block types and styles the content uses come along by themselves; links to this site\'s pages become plain addresses. ' +
      'kind "site" holds everything (pages, header and footer, menus, site fields with values, every style and the design) and requires admin. ' +
      'fonts: { families, redistributable_confirmed: true } adds uploaded font files only when the user confirmed their licence allows passing them on; catalog families need no files. Requires write permission.',
    inputSchema: {
      selection: z.object({
        kind: z.enum(['collection', 'site']),
        block_templates: ids.optional(), page_templates: ids.optional(), global_blocks: ids.optional(), block_types: ids.optional(), menus: ids.optional(),
        styles: z.enum(['used', 'all']).optional(), design: z.boolean().optional(), site_fields: z.boolean().optional(),
        fonts: z.object({ families: z.array(z.string()).max(60), redistributable_confirmed: z.literal(true) }).strict().optional(),
        demo_media: z.array(z.string()).max(2000).optional(),
      }).strict(),
      meta: z.object({
        id: z.string().describe('A slug for the package, e.g. "acme-restaurant-sections".'),
        name: z.string(), version: z.string().describe('e.g. "1.0.0"'),
        description: z.string().optional(),
        author: z.union([z.string(), z.object({ name: z.string(), url: z.string().optional() }).strict()]).optional(),
        licence: z.union([z.string(), z.object({ name: z.string(), url: z.string().optional() }).strict()]).optional(),
        languages: z.array(z.string()).max(20).optional(),
      }).strict(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'packages/export', body(args), v(args.version)))),
  },
  {
    name: 'inspect_package',
    description:
      'Read a Typeroll package and show what importing it into the site would do, without changing anything: the package (name, version, author, licence, counts), its signature (verified with the publisher when a trusted publisher signed it; unsigned or unknown otherwise), the plan (per style, block type, template, global block, menu, page and media file: create, reuse, rename or replace, with the id maps), warnings, errors that would stop the import, and needs (admin, font_licence). ' +
      STYLES + ' ' + DESIGN + ' Run it before import_package and show the user the plan.',
    inputSchema: { ...source, options: options.optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'packages/inspect', body(args), v(args.version)))),
  },
  {
    name: 'import_package',
    description:
      'Import a Typeroll package into the site: media first (into the Media library, reusing files with the same bytes; demo files are marked for replacement before publication), then fonts, block types, design and styles, global blocks, block templates (with where they came from), page templates, menus, site fields and, for a site package, pages. Returns a report of what was created, reused, renamed and replaced. ' +
      STYLES + ' ' + DESIGN + ' ' +
      'Requires write permission; admin for design "full" or when the import adds fonts or settings pages. The whole plan is checked before anything is written; a write that fails part-way answers package_import_partial with the report of what was written.',
    inputSchema: { ...source, options, version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'packages/import', body(args), v(args.version)))),
  },
];
