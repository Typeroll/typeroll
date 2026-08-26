import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const appTools: ToolDef[] = [
  {
    name: 'list_apps',
    description:
      'List every Typeroll app available to this site, including its field schema, build impact, and masked enabled/config state. Admin permission required.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      return ok(await client.get(siteId, 'apps'));
    }),
  },
  {
    name: 'read_app',
    description:
      'Read one Typeroll app by registry id, including its field schema and masked state. Use list_apps to discover ids and required config fields. Secret values are never returned. Admin permission required.',
    inputSchema: {
      app_id: z.string().min(1).describe('Registry id returned by list_apps, for example analytics or integrations.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.get(siteId, `apps/${encodeURIComponent(args.app_id)}`));
    }),
  },
  {
    name: 'update_app',
    description:
      'Enable, configure, or disable any registered Typeroll app through the same admin API key used for publishing. Read the app first and send config keys from its field schema. Omitted fields preserve existing values, including encrypted secrets; secret values are masked on reads and encrypted server-side on writes. Analytics provisioning runs server-side when enabled. If affects_build is true, trigger_deploy is required to publish the change. Admin permission required.',
    inputSchema: {
      app_id: z.string().min(1).describe('Registry id returned by list_apps.'),
      enabled: z.boolean(),
      config: z.record(z.unknown()).optional().describe('Schema-driven app config. Omitted fields preserve their existing values.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.put(siteId, `apps/${encodeURIComponent(args.app_id)}`, {
        enabled: args.enabled,
        config: args.config ?? {},
      }));
    }),
  },
];
