import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';
const fields = {
  label: z.string().optional(), icon: z.string().optional(), applies_to: z.string().optional(),
  blocks: z.array(z.any()).optional(), status: z.enum(['draft', 'published']).optional(),
};
export const pageTemplateTools: ToolDef[] = [
  { name: 'list_page_templates', description: 'List reusable Page templates in the selected version, including inherited templates.', inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'page-templates', { version: args.version }))) },
  { name: 'read_page_template', description: 'Read one reusable Page template and its block tree.', inputSchema: { template_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `page-templates/${encodeURIComponent(args.template_id)}`, { version: args.version }))) },
  { name: 'create_page_template', description: 'Create a reusable template. Choose a starter or provide blocks, including template_content_slot for the Page body. Assign its ID to a content type’s template or a Page’s template.', inputSchema: { name: z.string(), ...fields, starter: z.enum(['blog', 'article', 'checklist', 'team', 'events', 'products', 'custom']).optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => { const { version, ...body } = args; return ok(await client.post(siteId, 'page-templates', body, { version })); }) },
  { name: 'update_page_template', description: 'Update a reusable Page template. The change is saved immediately and affects its Pages on the next publication. A version isolates the edit from main.', inputSchema: { template_id: z.string(), patch: z.object(fields), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.patch(siteId, `page-templates/${encodeURIComponent(args.template_id)}`, args.patch, { version: args.version }))) },
  { name: 'delete_page_template', description: 'Delete an unused Page template. Reassign any Pages or content types using it first.', inputSchema: { template_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `page-templates/${encodeURIComponent(args.template_id)}`, { version: args.version }))) },
];
