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
  {
    name: 'install_extension',
    description:
      'Install an Extension release on this site, as the portal\'s install action does. Pass the Extension id and a published release (developer organizations may also install their own draft or review releases on their own sites). granted_scopes must be a subset of the manifest\'s requested permissions — grant only what the user approved. config must satisfy manifest.config_schema; secret values are encrypted and never returned. Does not deploy: trigger_deploy afterwards to publish provisioned components. Admin permission required.',
    inputSchema: {
      extension_id: z.string().min(1),
      version: z.string().min(1).describe('Release version to install.'),
      granted_scopes: z.array(z.string()).optional().describe('Approved scopes; defaults to none.'),
      config: z.record(z.unknown()).optional(),
      developer_org_id: z.string().optional().describe('Organization that publishes the Extension. Defaults to the key\'s own organization.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.post(siteId, 'extensions', args));
    }),
  },
  {
    name: 'set_extension_installation_status',
    description:
      'Enable or disable an installed Extension on this site. Disabling removes its components from the public snapshot and editor until re-enabled; page instances are kept. Changes apply immediately to previews; deploy to publish. Admin permission required.',
    inputSchema: {
      installation_id: z.string().min(1),
      status: z.enum(['enabled', 'disabled']),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.patch(siteId, `extensions/${encodeURIComponent(args.installation_id)}`, { status: args.status }));
    }),
  },
  {
    name: 'uninstall_extension',
    description:
      'Uninstall an Extension from this site: revokes the installation and all its server credentials and removes its block definitions. Existing page blocks remain as unavailable placeholders. Not reversible except by installing again (a new installation id). Get explicit user approval. Admin permission required.',
    inputSchema: { installation_id: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.del(siteId, `extensions/${encodeURIComponent(args.installation_id)}`));
    }),
  },
  {
    name: 'pair_extension_issuer',
    description:
      'Pair this Typeroll instance\'s token issuer with the Extension provider (manifest auth.pairing_url), the portal\'s "secure connection" action. Contacts the provider. Returns the trusted issuer record. Admin permission required.',
    inputSchema: { installation_id: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.post(siteId, `extensions/${encodeURIComponent(args.installation_id)}/pair`));
    }),
  },
  {
    name: 'read_extension_diagnostics',
    description:
      'Read an installation\'s diagnostics: status, health, release resolution, credential metadata (no secrets), the latest audit events and lifecycle event deliveries, and declared URL context inputs. Admin permission required.',
    inputSchema: { installation_id: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.get(siteId, `extensions/${encodeURIComponent(args.installation_id)}/diagnostics`));
    }),
  },
  {
    name: 'launch_extension_admin_page',
    description:
      'Issue a single-use, short-lived launch grant for one of the Extension\'s admin pages (manifest admin.pages), as opening the page in the portal does. Returns { launch_url, method, form, expires_at }: a browser tool must POST the `form` fields to launch_url before expires_at. The provider sees the caller as api-key:{prefix}. Treat the code as a credential. For approved native pages prefer call_extension_admin. The page\'s minimum_permission applies.',
    inputSchema: {
      installation_id: z.string().min(1),
      page_id: z.string().min(1).describe('Admin page id from the installation manifest.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.post(siteId, `extensions/${encodeURIComponent(args.installation_id)}/launch`, { page_id: args.page_id }));
    }),
  },
];

const ext = (id: string) => `extensions/${encodeURIComponent(id)}`;

/** Extension developer tools — the `typeroll extension` CLI's API. They act on
 *  the key's own organization, not on a site, and need an
 *  organization-scoped key (a site key gets 403). */
export const developerExtensionTools: ToolDef[] = [
  {
    name: 'list_developer_extensions', noSite: true,
    description: 'List Extensions registered by your organization (developer side). Requires an organization API key.',
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.developer('GET', 'extensions'))),
  },
  {
    name: 'read_developer_extension', noSite: true,
    description: 'Read one of your organization\'s Extensions with all saved releases and their status (draft, review, published, deprecated, revoked). Requires an organization API key.',
    inputSchema: { extension_id: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.developer('GET', ext(args.extension_id)))),
  },
  {
    name: 'update_developer_extension', noSite: true,
    description: 'Update an Extension\'s name, status (active/suspended), distribution (only while every release is a draft), trusted origins or private allow-lists. Requires an organization API key.',
    inputSchema: {
      extension_id: z.string().min(1),
      name: z.string().optional(),
      status: z.enum(['active', 'suspended']).optional(),
      distribution: z.enum(['private', 'unlisted', 'public']).optional(),
      trusted_origins: z.array(z.string()).optional(),
      allowed_org_ids: z.array(z.string()).optional(),
      allowed_site_ids: z.array(z.string()).optional(),
    },
    handler: withErrorBoundary(async (args, { client }) => {
      const { extension_id, ...patch } = args;
      return ok(await client.developer('PATCH', ext(extension_id), patch));
    }),
  },
  {
    name: 'save_extension_version', noSite: true,
    description: 'Save (create or replace) a draft release from a full Extension manifest. Published releases are immutable; bump manifest.version instead. Validate locally with `typeroll extension validate` first. Requires an organization API key.',
    inputSchema: {
      extension_id: z.string().min(1),
      manifest: z.record(z.unknown()).describe('Complete manifest; its id must equal extension_id.'),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.developer('POST', `${ext(args.extension_id)}/versions`, { manifest: args.manifest }))),
  },
  {
    name: 'publish_extension_version', noSite: true,
    description: 'Publish a saved release after verifying its asset digests. Private releases become installable for allowed organizations and sites; public releases enter review before catalog discovery. Installations follow compatible published releases automatically, so get user approval. Requires an organization API key.',
    inputSchema: { extension_id: z.string().min(1), version: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.developer('POST', `${ext(args.extension_id)}/versions/${encodeURIComponent(args.version)}/publish`))),
  },
  {
    name: 'set_extension_version_lifecycle', noSite: true,
    description: 'Deprecate or revoke a release. Revoking stops installations from resolving to it. Requires an organization API key.',
    inputSchema: {
      extension_id: z.string().min(1),
      version: z.string().min(1),
      status: z.enum(['deprecated', 'revoked']),
      reason: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client }) => {
      const { extension_id, version, ...body } = args;
      return ok(await client.developer('PATCH', `${ext(extension_id)}/versions/${encodeURIComponent(version)}`, body));
    }),
  },
  {
    name: 'list_developer_extension_installations', noSite: true,
    description: 'List operational metadata (status, versions, health; never config) for your Extension\'s installations on one customer site. Requires an organization API key and the customer\'s organization and site ids.',
    inputSchema: { extension_id: z.string().min(1), owner_org_id: z.string().min(1), site_id: z.string().min(1) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.developer('GET', `${ext(args.extension_id)}/installations`, undefined, {
      owner_org_id: args.owner_org_id, site_id: args.site_id,
    }))),
  },
];
