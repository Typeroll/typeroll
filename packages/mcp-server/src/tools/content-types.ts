import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';
const schema = z.array(z.object({ name: z.string(), label: z.string(), type: z.string() }).passthrough());
const fields = {
  label_singular: z.string().optional(), label_plural: z.string().optional(), fields: schema.optional(),
  page_field_rules: z.record(z.object({ label: z.string().optional(), writable_by: z.array(z.enum(['portal', 'owner', 'agent', 'app', 'import'])) })).optional(),
  allowed_templates: z.array(z.string()).nullable().optional().describe('Allowed Page template IDs, including the default. Null allows all compatible templates; an empty list permits no template.'),
  route_template: z.string().optional(), template: z.string().optional(), schema_type: z.string().optional(),
  schema_field_map: z.record(z.string()).optional(),
  icon: z.string().optional(), sort_field: z.string().optional(), sort_dir: z.enum(['asc', 'desc']).optional(),
  facets: z.array(z.record(z.unknown())).optional(), facet_combinations: z.array(z.record(z.unknown())).optional(),
};
export const contentTypeTools: ToolDef[] = [
  { name: 'page_completeness', description: 'Report missing, unverified and stale fields for Pages of one content type, with per-field counts and worst-first Page IDs. Read-only; agent-writable fields only by default.', inputSchema: { content_type: z.string(), limit: z.number().int().min(1).max(200).optional(), stale_after_days: z.number().min(0).optional(), agent_writable_only: z.boolean().optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => { const { content_type, ...query } = args; return ok(await client.get(siteId, `content-types/${encodeURIComponent(content_type)}/completeness`, query)); }) },
  { name: 'change_page_content_type', description: 'Change a saved Page to another content type. Preserves its identity, block body, status and existing URL. Save or discard its working copy first. If supplied, fields replaces the complete custom fields object; omitted fields are kept and must be valid for the new type. Snapshots a revision before changing.', inputSchema: { page_id: z.string(), content_type: z.string(), fields: z.record(z.unknown()).optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => { const { page_id, version, ...body } = args; return ok(await client.post(siteId, `pages/${encodeURIComponent(page_id)}/content-type`, body, { version })); }) },
  { name: 'list_content_types', description: 'List the field schemas, URL patterns, sorting, allowed templates and default templates for Pages. All content is a Page; use list_pages with content_type to filter.', inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'content-types', { version: args.version }))) },
  { name: 'read_content_type', description: 'Read one Page content type.', inputSchema: { name: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `content-types/${encodeURIComponent(args.name)}`, { version: args.version }))) },
  { name: 'create_content_type', description: 'Create a Page content type. Title, slug, block body, SEO and status are built in; fields defines custom fields only. An empty route_template means pages of this type have no public URL.', inputSchema: { name: z.string(), ...fields, label_singular: z.string(), label_plural: z.string(), fields: schema, route_template: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => { const { version, ...body } = args; return ok(await client.post(siteId, 'content-types', body, { version })); }) },
  { name: 'update_content_type', description: 'Update a Page content type. Changes affect all its pages at the next publication; explicit per-page paths remain overrides. The default template must be allowed; removing templates used by saved Pages is rejected.', inputSchema: { name: z.string(), patch: z.object(fields), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.patch(siteId, `content-types/${encodeURIComponent(args.name)}`, args.patch, { version: args.version }))) },
  { name: 'delete_content_type', description: 'Delete an unused content type. Reassign or delete its pages first; the standard Page type cannot be deleted.', inputSchema: { name: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `content-types/${encodeURIComponent(args.name)}`, { version: args.version }))) },
];
