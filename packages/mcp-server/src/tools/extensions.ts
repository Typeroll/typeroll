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
      'Update schema-defined config for an installed Extension. Call read_extension_installation first and send only keys declared by manifest.config_schema. Omitted fields preserve their current values, including masked secrets. This can update public content such as consent text, policy-link text, and policy URLs. A production deploy is queued by default; pass deploy:false only when batching changes and deploy later. Admin permission required.',
    inputSchema: {
      installation_id: z.string().min(1).describe('Installation id returned by list_extension_installations.'),
      config: z.record(z.unknown()).describe('Config keys and values declared by the installation manifest config schema.'),
      deploy: z.boolean().optional().describe('Queue a production deploy after saving. Defaults to true.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const updated = await client.patch<Record<string, unknown>>(
        siteId,
        `extensions/${encodeURIComponent(args.installation_id)}`,
        { config: args.config },
      );
      if (args.deploy === false) return ok(updated);
      try {
        const deploy = await client.post<Record<string, unknown>>(
          siteId,
          'deploy',
          { environment: 'production' },
        );
        return ok({ ...updated, deploy });
      } catch (error) {
        throw new Error(
          `Extension configuration was saved, but the deploy could not be queued: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  },
];
