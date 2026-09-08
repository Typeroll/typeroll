# Hosting Groups

## Accepted design

An Organization owns members, permissions, its GitHub connection, and shared
media storage. A Hosting Group owns a Cloudflare hosting connection and a site
address base. Each Site belongs to one Hosting Group and keeps its own source
repository, Pages project, version branches, and optional website/media hosts.

Create a Default group automatically. Existing organizations and sites resolve
to Default without copying credentials, changing URLs, moving files, or
reconnecting integrations. Only show a group choice when more than one exists.
Groups describe hosting infrastructure, not content categories or niches.

The existing organization Cloudflare connection remains the shared media and
DNS connection. Default reuses it for hosting. Additional groups have separately
encrypted, independently refreshed hosting authorizations. GitHub remains
organization-wide. Never copy a rotating OAuth grant into another connection.

## Domains and accounts

For example, Default uses sites.example.com and a second group uses
sites2.example.com. Register each site hostname with its Pages project, then
create its CNAME in the account which owns the DNS zone. DNS account selection
is separate from Pages account selection. External DNS remains supported with
structured instructions and independent verification. No new registered domain
or transfer of root hosting is required for a group's site address base.

Cloudflare Pages custom branch domains require proxied Cloudflare DNS. Verify
cross-account branch routing independently; never accept a response from the
production branch as a successful branch publication. Unsupported arrangements
must return an actionable requirement rather than silently route to main.

The organization's shared media hostname stays with its R2 account. R2 custom
domains require a zone in that account; separate subdomain zones require
Enterprise. Hosting Groups do not require their own R2 buckets or media zones.

## Media in static publications

Uploads go directly to verified organization R2 storage. Original files remain
private. Editor/preview and retained public media aliases continue using that
storage. No image binaries or credentials are committed to GitHub.

During a customer build, fetch only the frozen publication's required media
using scoped access, verify content hashes, generate required variants, and
include public assets in the static output. Default publication URLs use the
website's own origin and a safe media path. Publish pages and their assets as
one deployment. Retain previously published paths where required by aliases;
reject collisions with pages or reserved output files. Never copy private
originals merely because they exist in the bucket.

Keep separate website and media host settings. A separate media hostname needs
an explicit verified static serving target; do not silently attach it to a
different account's R2 bucket. Preserve existing published configurations during
the transition. A customer source build remains independent of the CMS once its
source and required media are available.

## Migration and safety

Use idempotent Default initialization and backwards-compatible reads. Freeze the
group, hosting account, domain revision, and media source in each publication.
Changing settings must not redirect an in-flight job to another account. Moving
an already published site between groups is an explicit migration requiring a
verified candidate, not an ordinary metadata edit.

Organization admins manage groups/connections; site admins may only select
eligible organization groups for a site within their scope. UI, authenticated
API, and MCP use the same validation. Reject cross-organization identifiers,
stale revisions, unknown groups, and secrets in public responses.

## Delivery and proof

Hosting Groups shipped in Core 0.1.45 and passed the Cloud staging browser
journey on desktop and mobile. Real cross-account qualification is still
in progress; a second account is connected, but its Cloudflare Git installation
has not yet been verified. The complete pilot is not yet qualified.

1. Default migration, group CRUD, authorization and connection isolation.
2. Publishing UI, site assignment, public API and MCP parity.
3. Group-aware Pages operations and independently selected DNS operations.
4. Static media packaging, legacy aliases, branches and rollback.
5. Focused regressions, full Core gate, immutable release and Cloud staging.
6. Real customer account checks, public-domain migration pilot, desktop/mobile
   screenshots, and an evidence report separating passed and unverified cases.

Cloud production remains outside this staging rollout. Cloudflare's provider
limits still apply to each account; multiple groups do not promise unlimited
provider capacity.

## Provider references

- https://developers.cloudflare.com/pages/configuration/custom-domains/
- https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/

## Public cache after deployment

A successful Pages build can coexist with stale responses on its custom domain.
After the exact static deployment and domain are ready, invalidate only the
site hostname through the DNS-owning Cloudflare account, then verify the public
publication. A separately hosted static media hostname receives its own purge.
Never purge the whole zone or unrelated site hosts. Record successful purges per
deployment and hostname; defer provider rate limits without marking the site live.

New OAuth consent includes the optional `cache.purge` scope. Existing connections
need renewed consent with Cache Purge enabled, or API tokens with Zone → Cache
Purge permission. Missing access returns `publishing_cache_access_required` with
UI instructions. External DNS/CDN operators remain responsible for invalidating
any additional cache they place in front of Pages.

Cloudflare documents hostname purges for every plan, including Free:
https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits

## Organization setup through MCP

Organization publishing tools do not take `site_id`. An organization with no
sites can list and save Hosting Groups, connect hosting, and configure shared
domains/media. Core 0.1.47 / MCP 0.44.20 corrects the transport schema, which
previously required a site even for these organization operations. Organization
API authorization remains enforced by the public routes. Reading or changing a
site's group still requires access to that particular site.

## Connect Git in an additional hosting account

Typeroll's organization GitHub App and Cloudflare's GitHub integration are
separate connections. Connecting a Hosting Group through Cloudflare OAuth does
not install Cloudflare's GitHub integration in that account.

In Cloudflare, select the new hosting account, then go to **Workers & Pages →
Create application → Pages → Connect to Git → + Add account**. Select the same
GitHub organization used by Typeroll and authorize access to all repositories so
future generated site repositories are included. Return to Typeroll and retry
publishing; Typeroll creates the site project. Keep the existing Cloudflare Git
installation connected, since other sites can depend on it.

Core 0.1.48 preserves the provider HTTP status, numeric error codes, hosting
account and Hosting Group when project creation fails. Cloudflare code 8000011
identifies the missing Git installation observed during qualification. Other
permission errors, rate limits and service errors have separate instructions.
Raw provider response bodies are never included in application errors or logs.

See the [Cloudflare Git integration guide](https://developers.cloudflare.com/pages/configuration/git-integration/).

## Remaining cache qualification

The current publication marker proves that the new deployment is reachable; it
does not prove that every removed URL is absent. Real lifecycle qualification
found an old HTML response on a custom hostname even after both hostname and
single-URL purges returned success. The corresponding Pages project URL and a
fresh query returned 404. No custom cache rule explained the difference.
This remains unresolved: do not treat a successful marker probe or purge API
response as evidence that page removal has passed. Do not purge unrelated
customer hosts or switch traffic to bypass this failure.
