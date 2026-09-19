import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const extensionTools: ToolDef[] = [
  {
    name: 'call_extension_admin',
    description: 'Call an enabled app’s approved admin API using the current site administrator identity. Read that installed app’s guide first for supported paths and effects. GET reads; POST can change app settings. No deployment is queued by Core. Ordinary admin credentials only; installation credentials cannot delegate. Tokens stay server-side.',
    inputSchema: {
      installation_id: z.string().min(1), page_id: z.string().min(1),
      path: z.string().describe('Relative operation below the approved native API base, from the installed app guide.'),
      method: z.enum(['GET', 'POST']), query: z.record(z.string()).optional(), body: z.record(z.unknown()).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { installation_id, ...operation } = args;
      return ok(await client.post(siteId, `extensions/${encodeURIComponent(installation_id)}/admin-request`, operation));
    }),
  },
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
    name: 'activate_extension_release',
    description: 'Explicitly activate a pending migration release for this site only. First read_extension_installation and review pending_activation_manifest, configuration and app migration instructions. Changes runtime selection immediately; never queues publication. Existing permissions remain unless granted_scopes is explicitly supplied. Admin permission required.',
    inputSchema: {
      installation_id: z.string().min(1),
      version: z.string().min(1).describe('Pending published release to activate.'),
      config: z.record(z.unknown()).optional(),
      granted_scopes: z.array(z.string()).optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { installation_id, ...patch } = args;
      return ok(await client.patch(siteId, `extensions/${encodeURIComponent(installation_id)}`, patch));
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
