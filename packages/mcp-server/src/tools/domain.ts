// Custom-domain lifecycle tools. Wrap the four /api/v1/sites/{id}/domain/*
// routes so an agent can read, attach, poll, or remove a
// custom domain through MCP. Admin-only on the server side; site-scoped
// keys are implicitly admin, org-scoped keys forward the share's
// permission.
//
// State machine recap (see docs/domain-lifecycle-plan.md):
//
//   no domain   ──add_domain──▶  pending
//   pending     ──poll_domain──▶ pending | verified | failed
//   any state   ──remove_domain──▶ no domain
//
// `production_url` on the site response (list_sites / read_site) only
// reflects the custom domain when status === 'live'. Until then,
// agents should send users to the fallback URL.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const domainTools: ToolDef[] = [
  {
    name: 'onboard_publishing_domain_zone', noSite: true,
    description: 'Organization-admin DNS onboarding for a site owned by that organization. Create a zone in its Hosting Group account, start a Cloudflare DNS scan, review the discovered records against current public DNS and existing zone records, then apply a reviewed plan as DNS only. Nameservers are returned for the human registrar step; never changed automatically. A scan is incomplete: confirm the full old-provider inventory, especially MX/SPF/DKIM/DMARC, before applying. Existing conflicting records are never replaced. Only pending zones can import records; active zones use normal domain management.',
    inputSchema: { site_id: z.string(), zone_name: z.string(), action: z.enum(['create_zone', 'scan_dns', 'review_dns', 'apply_dns']), plan_revision: z.string().optional(), confirm_inventory: z.boolean().optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/domain-onboarding', args))),
  },
  {
    name: 'guide_publishing_domain_change',
    description: 'Guide a site domain move. Start with check: returns hosting, zone, nameserver, certificate, permission, publishing, redirect capacity, candidate_noindex and candidate checks, current phase, next action and an explicit switch summary. candidate_noindex blocks prepare and approve while site settings, the last publication or the candidate tell search engines not to index or follow the site (next_action resolve_noindex): the temporary address is already blocked from indexing by Typeroll, so prepare with confirm_disable_noindex: true to turn it off and build an indexable candidate in one step, or pass allow_noindex_launch: true to launch hidden on purpose. Saving future hosts is inert. Prepare republishes the last public content on main with the new origins, replacing the current site before DNS changes; newer unpublished CMS edits are excluded. Later normal publications retain the new origins. Approve changes DNS for the same main artifact without another build. Adding redirect hosts preserves the main artifact. Approve requires explicit user approval of the switch summary and any validation interruption. Automatic DNS is journaled and rolled back after a failed check or the agreed deadline; later external edits require manual attention. Rollback requests restoration through the serialized publication chain. External DNS remains the caller’s responsibility.',
    inputSchema: {
      action: z.enum(['check', 'preview', 'save', 'prepare', 'approve', 'rollback']),
      revision: z.string().optional(), candidate_id: z.string().optional(),
      website_host: z.string().nullable().optional(), media_host: z.string().nullable().optional(), media_path_prefix: z.string().optional(),
      redirect_hosts: z.array(z.string()).max(4).optional(), dns_mode: z.enum(['automatic', 'external']).optional(),
      confirm_rebuild: z.boolean().optional(), accept_validation_window: z.boolean().optional(),
      validation_timeout_minutes: z.number().int().min(5).max(45).optional(),
      confirm_disable_noindex: z.boolean().optional().describe('For prepare: Turn off sitewide_noindex and sitewide_nofollow (and remove noindex from a robots meta tag in scripts_head) in the site settings and build the candidate indexable for the new website host in the same step, without a separate publication. Use this after the user confirms the site should be found by search engines; it satisfies the candidate_noindex blocker.'),
      allow_noindex_launch: z.boolean().optional().describe('For prepare and approve: set only when Search engines are told to skip this site (sitewide_noindex, sitewide_nofollow or a robots noindex meta in scripts_head) and you deliberately want to launch it hidden. Without it, a site with authored noindex is rejected with candidate_noindex. Typeroll already blocks indexing of the temporary address, so sitewide_noindex is not needed during migration; normally turn it off and publish instead.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/domain-guide', args))),
  },
  {
    name: 'check_managed_site_migration',
    description: 'Verify migration of an existing static managed Pages site to connected Git publishing. Checks the original hosting account, project, domain and shared build engine. Returns a revision and previous live deployment; does not migrate or deploy.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing/managed-migration'))),
  },
  {
    name: 'migrate_managed_site_publishing',
    description: 'Explicitly migrate one managed Pages site to the connected GitHub organization and shared build engine using the revision from check_managed_site_migration. Requires site admin permission. Preserves the original hosting project, live domain and old media URLs, then queues verified media copying for eligible sites. Does not deploy; publish after media migration finishes.',
    inputSchema: { revision: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/managed-migration', args))),
  },
  {
    name: 'read_organization_publishing_connections', noSite: true,
    description: 'Read the Organization\'s GitHub and Cloudflare publishing connections: status, revision (needed to change or disconnect), account identity, media_ready, media migration, github_setup (app_configured, encryption_available) and connect_urls. Requires an organization API key; never returns credentials. GitHub sign-in/App installation and Cloudflare OAuth need a person in a browser: give the user the matching connect_urls link (an organization owner or admin completes it), then read again. When GitHub is not connected, call diagnose_organization_github_connection to learn why and who must act; for Cloudflare, call diagnose_organization_cloudflare_connection. cloudflare_permissions lists, per Hosting Group, the optional capabilities of its Cloudflare connection (analytics_provisioning, analytics_reports, redirect_rules) with status available, approval_required, not_offered, unknown (API token) or connection_required, the exact missing_scopes, and permission_update: one "Approve update" at connect_url that an owner or admin approves once for every connection of the Organization using that Cloudflare account. Read it before update_app (Analytics) or set_publishing_domains (redirect_hosts).',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/connections'))),
  },
  {
    name: 'disconnect_organization_publishing_provider', noSite: true,
    description: 'Disconnect the Organization\'s GitHub or Cloudflare publishing connection at the revision from read_organization_publishing_connections. Erases stored credentials; does not delete repositories, buckets, media, DNS or published sites, but publishing through that provider stops until reconnected. After a GitHub disconnect, an owner or admin may connect a different GitHub account in the browser only after confirming which account it replaces; existing repositories are not moved. Requires an organization API key and the user\'s explicit go-ahead.',
    inputSchema: { provider: z.enum(['github', 'cloudflare']), revision: z.string(), hosting_group_id: z.string().optional().describe('Omit for the organization (Default) connection.') },
    handler: withErrorBoundary(async ({ provider, ...body }, { client }) => ok(await client.rootDelete(`publishing/connections/${provider}`, body))),
  },
  {
    name: 'connect_organization_cloudflare', noSite: true,
    description: 'Connect the Organization\'s default Cloudflare account without a browser, using a customer Cloudflare API token plus R2 access keys for an existing private bucket. Verifies the account, Pages access and the bucket before saving; credentials are encrypted and never returned. Requires an organization API key and the current revision. Reconnecting must keep the same account and bucket. An account another Organization already uses cannot be joined with an API key (claimed_by_other_organization): an owner or admin of that Organization connects it in the browser and confirms sharing it; the bucket must not be another Organization\'s. For additional Hosting Groups use connect_hosting_group.',
    inputSchema: {
      revision: z.string(), account_id: z.string().regex(/^[a-f0-9]{32}$/), bucket: z.string(),
      api_token: z.string(), access_key_id: z.string(), secret_access_key: z.string(),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/connections/cloudflare', { ...args, action: 'connect' }))),
  },
  {
    name: 'prepare_organization_media_storage', noSite: true,
    description: 'Create or reuse the Organization\'s private and public R2 media buckets in the connected Cloudflare account and configure upload CORS and lifecycle rules. Run after Cloudflare is connected and before save_organization_media_access. Requires an organization API key and the current Cloudflare revision. Idempotent.',
    inputSchema: { revision: z.string() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/connections/cloudflare', { ...args, action: 'prepare_media' }))),
  },
  {
    name: 'save_organization_media_access', noSite: true,
    description: 'Save and verify the Cloudflare R2 Access Key ID and Secret Access Key for the prepared media buckets (not the Cloudflare API token). Marks media storage ready, which imports require. The first activation moves existing media site by site; new keys for ready storage resume only stopped site migrations. Requires an organization API key and the current Cloudflare revision. Keys are encrypted and never returned.',
    inputSchema: { revision: z.string(), access_key_id: z.string(), secret_access_key: z.string() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/connections/cloudflare', { ...args, action: 'save_media' }))),
  },
  {
    name: 'check_organization_github_permissions', noSite: true,
    description: 'Check live GitHub build permissions (Actions and Workflows) of an already connected GitHub account without disconnecting or reconnecting. Requires an organization API key. Distinguishes an update the organization owner can approve from permissions Typeroll has not requested yet. Returns the existing installation approval URL only when actionable; does not enable a build engine. For a GitHub connection that is missing or failing, use diagnose_organization_github_connection.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/github-permissions'))),
  },
  {
    name: 'diagnose_organization_github_connection', noSite: true,
    description: 'Explain why the Organization\'s GitHub publishing connection is or is not working and who must do what next. Returns the Organization\'s state: diagnosis.outcome (connected, needs_attention, choose, action_required, waiting_on_owner, sign_in_required, retryable_error or unavailable), blockers, and the saved installation once connected. A person\'s unfinished attempt and their GitHub accounts stay in their own browser session. Each blocker has a code, who must act (you = the person connecting, github_owner, publisher = operator of this Typeroll installation, typeroll_admin), a message and one action: a github.com or documentation link, or a browser step (sign_in, install, retry, confirm_account_change) completed at connect_url. Read only, except recheck: true re-checks a connected installation (suspension, repository access, permissions) with the App\'s own authority. An API key cannot sign in to GitHub; relay the message and link to the user. Requires an organization API key; never returns credentials.',
    inputSchema: { recheck: z.boolean().optional().describe('Re-check the connected installation with the publisher App before answering.') },
    handler: withErrorBoundary(async ({ recheck }, { client }) => ok(await client.rootGet(`publishing/github-diagnosis${recheck ? '?recheck=true' : ''}`))),
  },
  {
    name: 'diagnose_organization_cloudflare_connection', noSite: true,
    description: 'Explain why a Cloudflare hosting connection (the Organization\'s Default Hosting Group, or hosting_group_id from list_hosting_groups) is or is not working and who must do what next. Returns the Organization\'s state: diagnosis.outcome (connected, needs_attention, choose, action_required, sign_in_pending, sign_in_required, retryable_error or unavailable), blockers, and the saved account once connected. A person\'s unfinished sign-in and the Cloudflare accounts they authorized stay in their own browser session. Each blocker has a code (for example oauth_cancelled, permissions_missing with missing_permissions, pages_access_denied, account_choice_expired, locked_to_account), who must act (you = the person connecting, cloudflare_account_admin, organization_admin = owner or admin of the Organization that already uses a shared account, publisher = operator of this Typeroll installation, typeroll_admin), a message and one action: a dash.cloudflare.com or documentation link, or a browser step (sign_in, retry) completed at connect_url. Read only, except recheck: true re-verifies a saved connection (authorization renewal, account access, Cloudflare Pages access, granted permissions) with its own authorization. An API key cannot sign in to Cloudflare; relay the message and link to the user. `permissions` reports the connection\'s optional capabilities (analytics_provisioning, analytics_reports, redirect_rules), their missing_scopes and the single permission_update next step; approving it enables Analytics for no Site. Requires an organization API key; never returns credentials.',
    inputSchema: {
      hosting_group_id: z.string().optional().describe('Omit for the organization (Default) connection.'),
      recheck: z.boolean().optional().describe('Re-verify a saved connection before answering.'),
    },
    handler: withErrorBoundary(async ({ hosting_group_id, recheck }, { client }) => {
      const query = new URLSearchParams({ ...(hosting_group_id ? { hosting_group: hosting_group_id } : {}), ...(recheck ? { recheck: 'true' } : {}) }).toString();
      return ok(await client.rootGet(`publishing/cloudflare-diagnosis${query ? `?${query}` : ''}`));
    }),
  },
  {
    name: 'setup_organization_build_engine', noSite: true,
    description: 'Prepare or update the organization Cloudflare or GitHub build engine and start its isolated execution and artifact-transfer check. Use the selected provider’s engine revision. Setup does not change the organization’s default provider. Requires an organization API key and current revision. Keeps site repositories, branches and Hosting Groups separate. Read the engine status until verification finishes.',
    inputSchema: { revision: z.string(), provider: z.enum(['cloudflare', 'github']).optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/builds', { ...args, action: 'setup' }))),
  },
  {
    name: 'read_organization_build_engine', noSite: true,
    description: 'Read the selected provider, saved Cloudflare and GitHub build engines, and active jobs for the organization (each with job_id, site_id, kind and status: queued, running, or publishing while a built publication uploads and verifies; image preparation jobs are media-…). A job stays listed until its deploy reaches a final status. Requires an organization API key; REST: GET /api/v1/publishing/builds. No provider credentials are returned.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/builds'))),
  },
  {
    name: 'check_organization_build_access', noSite: true,
    description: 'Check setup and qualification using the existing organization connection for the chosen provider. Omit provider for Cloudflare compatibility. Requires the current revision and an organization API key. Returns precise permission or qualification requirements; does not enable builds or change hosting.',
    inputSchema: { revision: z.string(), provider: z.enum(['cloudflare', 'github']).optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/builds', args))),
  },
  {
    name: 'select_organization_build_provider', noSite: true,
    description: 'Select a verified Cloudflare or GitHub engine for new publications. Requires an organization API key and selection.revision from read_organization_build_engine. Existing builds retain their provider, source and version.',
    inputSchema: { provider: z.enum(['cloudflare', 'github']), revision: z.string() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/builds', { ...args, action: 'select' }))),
  },
  {
    name: 'cancel_organization_build', noSite: true,
    description: 'Cancel an active GitHub build using its key from active_jobs. Requires an organization API key. Revokes the attempt before requesting provider cancellation; it cannot publish afterward. Completed builds cannot be cancelled here.',
    inputSchema: { key: z.string() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/builds', { ...args, action: 'cancel' }))),
  },
  {
    name: 'list_hosting_groups',
    noSite: true,
    description: 'List organization Hosting Groups, site address bases and safe hosting connection status. Requires an organization API key. Media and GitHub remain shared.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/hosting-groups'))),
  },
  {
    name: 'save_hosting_group',
    noSite: true,
    description: 'Create a Hosting Group, or update its name, site address base and DNS mode using its current id and revision. Requires an organization API key. Does not move existing sites, media, or traffic. Connect the hosting account in Publishing.',
    inputSchema: { id: z.string().optional(), revision: z.string().optional(), name: z.string(), sites_domain: z.string().nullable(), dns_mode: z.enum(['automatic', 'external']) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/hosting-groups', args))),
  },
  {
    name: 'connect_hosting_group',
    noSite: true,
    description: 'Connect or disconnect an additional Hosting Group using a customer Cloudflare API token. Requires an organization API key and the current connection revision from list_hosting_groups. Default uses organization Publishing. No R2 access is required for the hosting token. A Cloudflare account another Organization already uses cannot be joined with an API key (claimed_by_other_organization); disconnect removes only this group\'s use of a shared account. Credentials are encrypted and never returned.',
    inputSchema: { action: z.enum(['connect', 'disconnect']), hosting_group_id: z.string(), revision: z.string(), account_id: z.string().optional(), api_token: z.string().optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/hosting-groups', args))),
  },
  {
    name: 'read_site_hosting_group',
    description: 'Read the selected site Hosting Group and eligible organization groups. Omitted legacy assignments resolve to Default.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing/hosting-group'))),
  },
  {
    name: 'set_site_hosting_group',
    description: 'Select the Hosting Group for an unpublished site. Requires site admin permission and previous_group_id from read_site_hosting_group. Published sites or active builds require a hosting migration and are rejected.',
    inputSchema: { hosting_group_id: z.string(), previous_group_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'publishing/hosting-group', args))),
  },
  {
    name: 'list_organization_publishing_domains',
    noSite: true,
    description: 'List Cloudflare domains visible in the organization’s connected account, including activation, DNS hosting status and domain_access. Refresh this read to discover new domains; approval_required identifies missing OAuth consent without disconnecting the account. Requires an organization API key. Read only.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/zones'))),
  },
  {
    name: 'configure_organization_publishing_domains',
    noSite: true,
    description: 'Configure organization media and site subdomains using an active domain in the connected Cloudflare account. Attaches the media host to R2 and creates its DNS record; site media is not touched. Site/version addresses are created at deployment. Requires an organization API key and the current revision. Does not replace existing DNS destinations or existing media hosts. Read organization publishing domains afterward to check HTTPS activation.',
    inputSchema: { revision: z.string(), zone_id: z.string(), media_subdomain: z.string().describe('Short label, for example media.'), sites_subdomain: z.string().describe('Short label, for example sites.') },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/domains', args))),
  },
  {
    name: 'prepare_publishing_domain_change',
    description: 'Publish for the new domain shortly before changing DNS, using only the last successfully published snapshot. This replaces main at the current or temporary address; it does not create a separate preview branch. Publish intended edits normally at the current or temporary address first. Newer unpublished CMS changes are excluded. Normal publication remains available and keeps these embedded domain addresses while DNS is pending. It refreshes the receipt for the same main site; no second preparation is needed. Requires the current domain revision. Poll read_publishing_domains for certificate and DNS requirements, then explicitly approve the verified cutover.',
    inputSchema: {
      revision: z.string(),
      confirm_disable_noindex: z.boolean().optional().describe('Turn off sitewide_noindex and sitewide_nofollow (and remove noindex from a robots meta tag in scripts_head) in the site settings and build the candidate indexable for the new website host in the same step, without a separate publication. Use this after the user confirms the site should be found by search engines; it satisfies the candidate_noindex blocker.'),
      allow_noindex_launch: z.boolean().optional().describe('Set only when Search engines are told to skip this site (sitewide_noindex, sitewide_nofollow or a robots noindex meta in scripts_head) and you deliberately want to launch it hidden. Without it, a site with authored noindex is rejected with candidate_noindex. Typeroll already blocks indexing of the temporary address, so sitewide_noindex is not needed during migration; normally turn it off and publish instead.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/prepare', args))),
  },
  {
    name: 'read_organization_media_migration',
    noSite: true,
    description: 'Read progress and actionable failures while original media moves to the organization Cloudflare account. Requires an organization API key.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/media-migration'))),
  },
  {
    name: 'retry_organization_media_migration',
    noSite: true,
    description: 'Resume verified media migration after fixing account or R2 setup. Restarts only failed site migrations and stopped jobs; completed sites are not touched. Source files remain readable; pointer changes require matching hashes. Set prepare_transfer to set up or recheck the transfer worker in the organization Cloudflare account. Requires an organization API key.',
    inputSchema: { prepare_transfer: z.boolean().optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/media-migration', args.prepare_transfer ? { action: 'prepare_transfer', recheck: true } : {}))),
  },
  {
    name: 'read_publishing_readiness',
    description: 'Check required publishing connections and domains for the selected site. Returns actionable setup requirements. Editing and temporary previews remain available before publishing is configured.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing'))),
  },
  {
    name: 'approve_publishing_domain_cutover',
    description: 'Approve switching DNS to the current verified main publication, without another Git push, build or upload. Read the latest candidate_id; older receipts are rejected. Read publishing domains first and review DNS requirements, certificate readiness and redirect_preparations. Existing traffic is preserved until validation succeeds. With automatic DNS, redirect hosts switch after the website host: Typeroll ensures their zone redirect rule, then changes their reviewed record to a proxied placeholder. The publication goes live only after every redirect host answers 301 to the website host with the same path and query. When preparation.validation_blocker.resolution is accept_validation_window, Cloudflare can validate the website host only after its one existing record points at Pages: approving with accept_validation_window: true lets Typeroll change that record, and the host does not answer until Cloudflare validates it (Cloudflare does not document how long; previous_records holds the rollback). Get the user\'s explicit go-ahead for that window and choose a quiet time. External DNS management remains the caller’s responsibility.',
    inputSchema: {
      revision: z.string(), candidate_id: z.string(),
      validation_timeout_minutes: z.number().int().min(5).max(45).optional(),
      accept_validation_window: z.boolean().optional().describe('Accept the interruption until Cloudflare validates the website host after its single reviewed record changes. Only valid when preparation.validation_blocker.resolution is accept_validation_window.'),
      allow_noindex_launch: z.boolean().optional().describe('Set only when Search engines are told to skip this site (sitewide_noindex, sitewide_nofollow or a robots noindex meta in scripts_head) and you deliberately want to launch it hidden. Without it, a site with authored noindex is rejected with candidate_noindex. Typeroll already blocks indexing of the temporary address, so sitewide_noindex is not needed during migration; normally turn it off and publish instead.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/cutover', args))),
  },
  {
    name: 'read_publishing_domains',
    description: 'Read the desired and active website, redirect and media hosts, retained media aliases, DNS management mode and domain configuration revision. host_checks lists each future host with its Cloudflare zone and structured blockers and warnings (code, host, message), for example apex_zone_required (an apex such as example.com needs an active Cloudflare zone in the hosting account), zone_not_active (the zone is pending until its nameservers change) or redirect_zone_required. Resolve blockers before preparing. preparation and redirect_preparations hold DNS records, the zone redirect rule and certificate state after preparation. Saving intent does not switch traffic. published identifies the addresses embedded in main, separately from active (verified traffic). Saving desired hosts is inert. prepare_publishing_domain_change explicitly replaces main with the new origins; later normal publication retains them and refreshes the DNS approval receipt. candidate.sitewide_noindex describes the frozen candidate, not current settings. Prepare and approve reject an authored noindex launch with candidate_noindex unless allow_noindex_launch is true.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing/domains'))),
  },
  {
    name: 'set_publishing_domains',
    description: 'Save future website, redirect and media hosts before preparing a deployment. Normal trigger_deploy continues updating the current or temporary address, even while future hosts await validation. Shortly before changing DNS, explicitly call prepare_publishing_domain_change to publish the last published snapshot again with these hosts. That explicit publication replaces main before DNS changes. Later normal publications retain its new origins and refresh the DNS approval receipt; no second build is needed to switch DNS. Requires the current revision from read_publishing_domains. This does not publish content or change traffic DNS. Choose external DNS when your agent manages Cloudflare independently. redirect_hosts (for example www.example.com when example.com is the website host) answer 301 to the website host, keeping path and query, through a Single Redirect rule in the host\'s Cloudflare zone; they are switched and verified with the website. The response includes host_checks: resolve its blockers before preparing.',
    inputSchema: {
      revision: z.string(), website_host: z.string().nullable(), media_host: z.string().nullable(),
      confirm_rebuild: z.boolean().optional().describe('Legacy input; Core 0.2.116+ does not require confirmation to save inert future addresses.'),
      media_path_prefix: z.string().optional().describe('Empty on a separate media host; /media when using the website host.'),
      redirect_hosts: z.array(z.string()).max(4).optional().describe('Hostnames that redirect permanently to website_host, such as www.example.com. Omit or send [] for none.'),
      dns_mode: z.enum(['automatic', 'external']),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'publishing/domains', args))),
  },
  {
    name: 'read_organization_publishing_domains',
    noSite: true,
    description: 'Read the organization site address base, shared media host, live Cloudflare media-domain status and setup instructions. This read does not modify DNS. Requires an organization API key; site keys cannot access organization publishing settings.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/domains'))),
  },
  {
    name: 'set_organization_publishing_domains',
    noSite: true,
    description: 'Save separate organization hostnames: sites_domain for site and version addresses, media_host for shared media. Requires an organization API key and current settings revision. Automatic DNS mode queues media setup; external mode leaves DNS to you. Does not change nameservers or replace an existing media host.',
    inputSchema: { revision: z.string(), sites_domain: z.string().nullable().optional(), media_host: z.string().nullable().optional(),
      default_domain: z.string().nullable().optional().describe('Legacy shorthand for both hostnames; prefer sites_domain and media_host.'), dns_mode: z.enum(['automatic', 'external']) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPut('publishing/domains', args))),
  },
  {
    name: 'read_domain',
    description:
      "Read the current state of the site's custom domain. Returns " +
      '`{ hostname, status, dns_target, verified_at, failure_reason }` ' +
      "or `null` when no domain is attached. Status is one of 'pending' " +
      "(DNS not yet verified), 'verified' (DNS + cert OK, awaiting customer " +
      "activation), 'live' (production URL is now the custom domain), " +
      "'failed' (Cloudflare returned an error — see failure_reason).",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'domain');
      return ok(res);
    }),
  },
  {
    name: 'add_domain',
    description:
      "Attach a custom domain to this site. The site MUST NOT already have " +
      "a domain set — remove the existing one first. Declaring the domain " +
      "makes it canonical immediately and queues a production deploy by " +
      "default; point DNS only after that deploy. Returns the CNAME target. " +
      "Use `poll_domain` to observe DNS/SSL verification. There is no separate " +
      "activation step in the current domain-first workflow.",
    inputSchema: {
      hostname: z
        .string()
        .describe('Hostname to attach, e.g. "www.example.com". Leading https:// and trailing slashes are stripped.'),
      prefer: z
        .enum(['apex', 'www'])
        .optional()
        .describe('Canonical host for an apex/www pair. Defaults to apex.'),
      auto_deploy: z
        .boolean()
        .optional()
        .describe('Default true. Publish the canonical/sitemap change before DNS cutover.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain', args);
      return ok(res);
    }),
  },
  {
    name: 'poll_domain',
    description:
      "Ask Cloudflare for the current state of the attached domain and " +
      "update the site doc accordingly. Idempotent — call after DNS " +
      "changes propagate. Returns the new state; status may have advanced " +
      "from 'pending' to 'verified' or 'failed'.",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain/poll');
      return ok(res);
    }),
  },
  {
    name: 'activate_domain',
    description:
      "Legacy compatibility tool; new workflows should not call it. A declared " +
      "domain is already canonical and becomes visitable when DNS verifies. " +
      "For legacy records only, this changes the stored verified state to live. " +
      "Precondition: status must be 'verified' (or already 'live' — idempotent). " +
      "By default it also enqueues a production deploy; the " +
      "response includes `deploy.job_id` you can poll. Pass " +
      "`auto_deploy: false` to skip that compatibility deploy.",
    inputSchema: {
      auto_deploy: z
        .boolean()
        .optional()
        .describe('Default true. Enqueue a production deploy after activation so canonical URLs update.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain/activate', args);
      return ok(res);
    }),
  },
  {
    name: 'remove_domain',
    description:
      "Detach the custom domain from this site. Removes it from Cloudflare " +
      "Pages and clears the site doc. The fallback subdomain remains. " +
      "Use this when the customer wants to start over with a different " +
      "hostname or move the site to a different domain provider.",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.del(siteId, 'domain');
      return ok(res);
    }),
  },
];
