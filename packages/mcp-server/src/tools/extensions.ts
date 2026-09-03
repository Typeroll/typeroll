import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const extensionTools: ToolDef[] = [
  {
    name: 'list_extension_installations',
    description:
      'List the site\'s installed Extensions, including installation ids, manifests, config schemas, and masked current config. Read this before updating installation config. Admin permission required.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      return ok(await client.get(siteId, 'extensions'));
    }),
  },
  {
    name: 'read_extension_installation',
    description:
      'Read one Extension installation, its manifest config schema, and its masked current config. Secret values are never returned. Admin permission required.',
    inputSchema: {
      installation_id: z.string().min(1).describe('Installation id returned by list_extension_installations.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.get(siteId, `extensions/${encodeURIComponent(args.installation_id)}`));
    }),
  },
  {
    name: 'update_extension_installation_config',
    description:
      'Update schema-defined config for an installed Extension. Call read_extension_installation first and send only keys declared by manifest.config_schema. Omitted fields preserve their current values, including masked secrets. This can update public content such as consent text, policy-link text, and policy URLs. The response returns redeploy_required:true; call trigger_deploy separately after the change has been reviewed. Admin permission required.',
    inputSchema: {
      installation_id: z.string().min(1).describe('Installation id returned by list_extension_installations.'),
      config: z.record(z.unknown()).describe('Config keys and values declared by the installation manifest config schema.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.patch(
        siteId,
        `extensions/${encodeURIComponent(args.installation_id)}`,
        { config: args.config },
      ));
    }),
  },
];
