// Style library tools. A site's look is a library of NAMED styles
// (SiteSettings.styles): element roles (body, h1–h6, link) style every
// matching element, and every other style is chosen per block through the
// block's `style_id` field. Reuse beats one-off values.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

const COLOR_HELP = 'A palette token (primary, secondary, accent, background, surface, text, text_light), a derived readable text colour for a palette background (on_primary, on_secondary, on_accent), or a hex/rgb/hsl colour. Prefer tokens so a palette change flows through.';
const length = z.string().describe('CSS length: px, rem, em, %, vw, ch, or clamp()/min()/max()');
const color = z.string().describe(COLOR_HELP);

const propsSchema = z.object({
  font: z.enum(['heading', 'body', 'mono', 'inherit']).optional(),
  size: length.optional(),
  weight: z.number().int().min(100).max(900).optional(),
  line_height: z.string().optional().describe('Unitless number such as "1.5", or a length'),
  letter_spacing: z.string().optional().describe('e.g. "0.08em" or "normal"'),
  transform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  italic: z.boolean().optional(),
  color: color.optional(),
  background: color.optional(),
  align: z.enum(['left', 'center', 'right', 'start', 'end', 'justify']).optional(),
  decoration: z.enum(['none', 'underline']).optional(),
  space_before: length.optional(),
  space_after: length.optional(),
  padding: z.string().optional().describe('One to four CSS lengths'),
  max_width: length.optional(),
  radius: length.optional(),
  border: z.object({
    width: length.optional(),
    style: z.enum(['solid', 'dashed', 'dotted', 'none']).optional(),
    color: color.optional(),
    sides: z.enum(['all', 'top', 'right', 'bottom', 'left', 'block', 'inline']).optional(),
  }).optional(),
}).describe('Style properties. Mobile-first: `base` applies everywhere, `at.<breakpoint>` from that width up.');

const atSchema = z.object({
  tablet: propsSchema.optional(),
  laptop: propsSchema.optional(),
  desktop: propsSchema.optional(),
  wide: propsSchema.optional(),
}).describe('Overrides from each site breakpoint upward (tablet, laptop, desktop, wide).');

const styleFields = {
  name: z.string().describe('Author-facing name, in the site\'s language, e.g. "Överrubrik" or "Hero title".'),
  role: z.enum(['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'link', 'lead', 'eyebrow', 'small', 'quote', 'button', 'button_secondary', 'section']).optional()
    .describe('Standard role. body/h1–h6/link style every matching element on the site; the others mark the standard style for that purpose. One style per role.'),
  targets: z.array(z.enum(['text', 'heading', 'list', 'button', 'container'])).optional()
    .describe('Block kinds that can select this style via style_id (text = core/prose, heading = core/heading and core/rich_heading, list, button, container = core/section and core/container).'),
  description: z.string().optional().describe('When to use it; shown to editors and agents.'),
  base: propsSchema.optional(),
  at: atSchema.optional(),
  hover: z.object({ color: color.optional(), background: color.optional(), decoration: z.enum(['none', 'underline']).optional() }).optional(),
  css: z.string().optional().describe('Advanced CSS scoped to the style: bare declarations, or rules where `&` is the style selector (e.g. "&::before { content: \'—\' }"). Prefer structured properties.'),
};

export const styleTools: ToolDef[] = [
  {
    name: 'list_styles',
    description:
      'List the site\'s named style library: element roles (body, h1–h6, link) that style every matching element, and the styles blocks select with `style_id`. Also returns missing_standard_roles and contrast/library problems. READ THIS BEFORE STYLING ANY PAGE: reuse an existing style for a recurring look (eyebrows, leads, card titles, buttons, section spacing) instead of per-block values, raw HTML classes or page CSS.',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'styles', v(args.version)))),
  },
  {
    name: 'create_style',
    description:
      'Create a named style. Do this whenever a look could recur — an eyebrow, a lead paragraph, a card title, a quote, a button variant, a section rhythm — then apply it with the block\'s `style_id` field. Only a clearly unique one-off may use block settings instead. Set values for phones in `base` and grow them in `at.tablet`/`at.desktop`. Text must meet WCAG AA contrast (4.5:1, 3:1 for ≥24px or bold ≥18.7px) against its background; a failing style is refused. Never light grey on white.',
    inputSchema: {
      id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).describe('Stable slug; the CSS class becomes s-<id>. Cannot change later.'),
      ...styleFields,
      name: styleFields.name,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...style } = args;
      return ok(await client.post(siteId, 'styles', { targets: [], base: {}, ...style }, v(version)));
    }),
  },
  {
    name: 'update_style',
    description:
      'Update a style. `base`, `hover` and each breakpoint in `at` merge property by property (pass null to remove one); name, targets, description and css replace. Every page using the style changes at once — tell the user which pages that affects when it matters.',
    inputSchema: {
      style_id: z.string(),
      name: styleFields.name.optional(),
      role: styleFields.role,
      targets: styleFields.targets,
      description: styleFields.description,
      base: z.record(z.unknown()).optional().describe('Property patch for base; null removes a property.'),
      at: z.record(z.unknown()).optional().describe('Per-breakpoint property patches; null removes a breakpoint or property.'),
      hover: z.record(z.unknown()).optional(),
      css: z.string().optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, style_id, ...patch } = args;
      return ok(await client.patch(siteId, `styles/${encodeURIComponent(style_id)}`, patch, v(version)));
    }),
  },
  {
    name: 'delete_style',
    description: 'Delete a style. Blocks that still reference it fall back to their default look; reassign them first.',
    inputSchema: { style_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `styles/${encodeURIComponent(args.style_id)}`, v(args.version)))),
  },
  {
    name: 'apply_standard_styles',
    description:
      'Add the standard styles the site is missing (body, H1–H6, link, lead, eyebrow, small text, quote, primary/secondary button, section), with considered sizes and spacing for phones, tablets and desktops. The natural first step when building a new site, before pages: then adjust them to the brand (fonts, colours, scale) with update_style. New sites already have them. overwrite:true resets the standard roles to the defaults and changes the site\'s look — ask first.',
    inputSchema: { overwrite: z.boolean().optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'styles/standard', { overwrite: args.overwrite === true }, v(args.version)))),
  },
];
