# Connect customer-owned publishing accounts

Status: organization account connection is implemented. Core 0.1.20 simplifies
GitHub organization discovery. Customer acceptance remains pending.
Automatic site provisioning and editor publication are still being implemented.
See [implementation status](customer-owned-publishing.md).

Your organization owns the GitHub organization, publication repositories,
Cloudflare account, and media storage. The publisher receives access through a
GitHub App installation and scoped Cloudflare credentials. Customers do not
invite the publisher's developers or share a personal GitHub token.

Default reuses the organization Cloudflare account for its
sites. Each site receives a private generated repository and a Git-connected Pages project.
The site remains static; Forms and Extensions use their separately documented
runtime owners.

## GitHub organization and publisher installation

Use a customer-owned organization dedicated to generated site repositories.
An organization owner installs the publisher's GitHub App once. The pilot
requires **All repositories** so subsequent site creation does not need another
customer approval. Organization policies must permit private repository creation
by the App. Use `main` as the initial default branch.

The publisher App requests these repository permissions:

| Permission | Level | Purpose |
| --- | --- | --- |
| Administration | Read and write | Create and configure repositories |
| Contents | Read and write | Publish source files, commits, and branches |
| Metadata | Read | Identify repositories and verify access |

Also request **Organization permissions / Members / Read**. The connection
verifies that the signed-in GitHub user is an active owner of the selected
organization. A user who can see an installation is not necessarily allowed to
delegate its full installation-token authority.
[Organization membership API](https://docs.github.com/en/rest/orgs/members#get-organization-membership-for-a-user).

GitHub supports organization repository creation with an installation token
carrying **Administration: write**. This is broader repository administration
access, not a create-only permission. A dedicated organization bounds which
repositories the installation can administer.
[Repository creation API](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository).

The publisher owns and securely stores the App's private key. It uses the
customer's installation ID to mint installation tokens, which expire after one
hour. Customers do not create an App or manually renew these tokens.
[Installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

The publisher must register an externally installable App before customers can
connect. Open **Publishing** in Typeroll's sidebar. An explicit Typeroll organization owner or admin chooses
**Connect GitHub** and signs in. No typed organization name or ID is required.
If the App is not installed, the page provides installation instructions.
The server discovers eligible owner organizations with the App installed:
one connects directly; multiple organizations require an explicit selection.
That choice expires after ten minutes, is single-use and bound to the same
Typeroll user and organization. The server rechecks ownership when it is selected. GitHub authorization uses
PKCE and a ten-minute, single-use grant bound to the browser, Typeroll user, and
organization. The server checks the user's installations and active owner role,
then revalidates the installation through the App. It never trusts an
`installation_id` supplied in a callback, and it does not store the user token.
[GitHub setup URL security](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

The first connection reserves that provider account for its Typeroll
organization. Disconnecting preserves this ownership reservation and resource
identities. Reconnecting can rotate credentials for the original account;
moving to another account or Typeroll organization requires a separate migration.

## Cloudflare Git integration

In the customer's Cloudflare account, open **Workers & Pages → Create application
→ Pages → Connect to Git** (also labeled **Import an existing Git repository**).
Select **+ Add account** if the organization is missing. The customer authorizes Cloudflare's own GitHub App on
the same organization, also covering **All repositories** for this pilot.

Cloudflare needs its own repository access to clone and build the source.
The publisher's installation does not grant Cloudflare that access. If the
organization is empty, finish selecting the first repository after the
publisher creates it. Verify that later repositories become accessible without
reinstalling either App.
[Cloudflare GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/).

## Connect Cloudflare with sign-in

Open **Publishing** in Typeroll's sidebar and select
**Connect Cloudflare**. Sign in to Cloudflare and approve access to your
organization's account. Typeroll discovers authorized accounts; choose one if several are
available. You do not need to type an account name or Account ID or create a
general API token for this connection. Reuse the connection for all sites in
the Typeroll organization.

The publisher must configure a public Cloudflare OAuth client first. A private
client only accepts members of the publisher's own Cloudflare account, which
does not reproduce external customer onboarding.

After sign-in, Typeroll checks R2 automatically. If R2 is active, Typeroll
creates the organization's shared bucket and configures browser upload access.
You do not need to create the bucket yourself.

If the subscription is missing, the R2 section shows **R2 is not activated**
and a link to the connected Cloudflare account. Open **Storage & databases →
R2 object storage → Overview**, complete the subscription checkout, and enter
billing details if requested. Return to Typeroll and select
**I’ve activated R2 — check again**. The button checks Cloudflare's actual status;
it does not mark storage ready just because it was clicked.

Once **R2 storage prepared** appears, finish the one-time upload-key step:

1. Follow the account's R2 link. In **R2 object storage → Overview → Account
   Details → API Tokens**, select **Manage**.
2. Select **Create Account API token**, name it **Typeroll media**, and choose
   **Object Read & Write** restricted to the bucket shown in Typeroll.
3. Copy **Access Key ID** and **Secret Access Key** into the matching fields.
   Use these two values, not the field labelled **API token**. The secret is
   only shown when created.
4. Select **Verify keys and finish setup**.

Account tokens require a Cloudflare Super Administrator. If that option is
unavailable, a User API token works with the same permissions, but becomes
inactive if its owner is removed from the Cloudflare account.

Typeroll verifies write, read and delete access and stores the keys encrypted.
Errors appear beside the form with the required permission and bucket. A
successful check shows **R2 connected**, which persists after reload; the form
collapses under **Replace R2 access keys**. The connection is reused across the
organization's sites and branches.

Once organization media storage is verified, new uploads from existing sites
also go directly to that account. Finishing organization media setup adopts
existing sites into Git publishing; their current hosting and DNS stay intact
until the next requested publication. Existing website hosts are carried into
the site’s Publishing settings. Complete GitHub and domain setup before deploying.

The editor uses an authenticated media URL to keep unpublished originals private.
The static build replaces that URL with the configured public media hostname.
Existing images are copied and verified before their editable references change;
previously published files and URLs are retained.

Cloudflare's GitHub integration, described above, is still required for source
builds. OAuth account connection does not itself prove Git publication, public
media delivery or migration of existing sites.
[Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/),
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

## Advanced: existing Cloudflare API credentials

Use **Advanced: connect with existing API and R2 keys** when connecting an
existing token instead of using Cloudflare sign-in.

Open [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens),
then **Create Token → Create Custom Token → Get started**. Name the token, add
the permissions below, and scope **Account Resources → Include → Specific
account** to the customer. Finish with **Continue to summary → Create Token**.

To find **Account ID**, select the customer's account in Cloudflare, open
**Search**, and select **Copy account ID**. Alternatively, use **Workers & Pages
→ Account Details → Account ID**. Copy the 32-character account ID, not a domain's
Zone ID. [Cloudflare's account ID instructions](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

Use these token permissions:

| Permission | Purpose |
| --- | --- |
| Account / Cloudflare Pages / Edit | Manage Pages projects and deployments |
| Account / Account Settings / Read | Verify the connected account |
| Account / Workers R2 Storage / Edit | Configure buckets and CORS when automated storage setup is enabled |

The current first provider probe expects an existing bucket and does not need
R2 administration solely to upload its probe object. Automated bucket/CORS
configuration requires the R2 management permission. This account-level
management access is broader than bucket-scoped object credentials.
[Pages API](https://developers.cloudflare.com/pages/configuration/api/),
[R2 bucket creation](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/).

Domain cutover is a separate operation. Do not include DNS access merely to
prove repository creation and Git builds. A production domain and media domain
must be configured and verified before migrating a live site.

## R2 media credentials for the command-line probe

The customer activates R2 and completes Cloudflare's billing activation. For
the current probe, create a dedicated media bucket first. The intended setup
can share a bucket across sites using isolated site prefixes; site authorization
must be enforced by the publisher.

In **Storage & databases → R2 object storage → Overview → Account Details**,
select **Manage** next to **API Tokens**, then **Create Account API token**
(requires Super Administrator). Create **Object Read & Write** credentials scoped
to that bucket. Keep the Access Key ID and Secret Access Key, plus the bucket
name, account ID, and S3 endpoint shown by Cloudflare. The ordinary Cloudflare
API token is not a substitute for the S3 credential pair.
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

The S3 endpoint is not the public image URL. Real media publication also needs
a public delivery address and CORS for browser uploads. A successful server-side
upload/readback proves object access only, not browser CORS or tenant isolation.

## Connection data and secret ownership

| Value | Ownership and handling |
| --- | --- |
| GitHub organization and installation ID | Customer connection metadata |
| GitHub App ID and private key | Publisher configuration; private key is a publisher secret |
| GitHub installation token | Minted in memory for the customer's installation |
| Cloudflare account ID | Customer connection metadata |
| Cloudflare API token | Customer secret supplied through a secure connection flow |
| R2 bucket and S3 endpoint | Customer connection metadata |
| R2 Access Key ID and Secret Access Key | Customer credentials supplied through a secure connection flow |

The account page accepts Cloudflare and R2 credentials over the authenticated
same-origin API. It verifies the account, lists Pages projects, and uploads,
reads back, and deletes a random temporary object under
`_typeroll/connection-checks/` in the selected bucket. The connection currently
supports the standard global R2 endpoint derived from the Account ID; arbitrary
S3 endpoints and jurisdiction-specific buckets are not accepted. Listing Pages
projects proves read access, not project creation permission. The three-site
pilot remains the write/build acceptance gate.

Credentials are encrypted with AES-256-GCM, bound to the Typeroll organization
and provider, and excluded from API responses. The page shows only whether
credentials are saved. Rotation and disconnect use revision checks, and
disconnect removes the saved Cloudflare/R2 credentials without deleting customer
resources. An in-flight authorization cannot undo a disconnect.

Never send credential values through chat, commit them, or put them in a
generated site repository. Customers can independently revoke the GitHub App
installation and Cloudflare credentials.

## Publisher configuration

Configure the following server-side variables per environment. The customer
does not supply publisher App credentials. Use separate Apps and secret storage
for production, staging, and local development; never copy live keys into tests.

| Variable | Value |
| --- | --- |
| `PORTAL_PUBLIC_URL` | Canonical HTTPS portal origin, with no path or query |
| `TYPEROLL_PUBLISH_GITHUB_APP_ID` | Numeric publisher App ID |
| `TYPEROLL_PUBLISH_GITHUB_APP_SLUG` | App slug used for the installation link |
| `TYPEROLL_PUBLISH_GITHUB_CLIENT_ID` | App OAuth client ID, distinct from App ID |
| `TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET` | App OAuth client secret; secret-manager value |
| `TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY` | App RSA private key in PEM form; secret-manager value |
| `TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID` | Public Cloudflare OAuth Client ID for this environment |
| `TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET` | Cloudflare OAuth client secret; secret-manager value |
| `INTEGRATIONS_SECRET_KEY` | Existing encryption key, at least 32 characters; retain during normal redeploys |

Register exactly `{PORTAL_PUBLIC_URL}/api/orgs/publishing/github/callback` as
the App's OAuth callback. The implementation uses an explicit authorization
step after installation; it does not need a setup URL or an installation webhook
to trust the connection. Do not enable "Request user authorization (OAuth)
during installation": install first, then start authorization from Typeroll.
Keep expiring user tokens enabled. This first delivery does not consume
webhooks; publication must revalidate installation access before each operation.

Register `{PORTAL_PUBLIC_URL}/api/orgs/publishing/cloudflare/callback` for the
Cloudflare client. Enable authorization-code and refresh-token grants with
`client_secret_basic` authentication. Use the required scopes
`account-settings.read`, `page.read`, `page.write`, `workers-r2.read`, and
`workers-r2.write`; Cloudflare adds `offline_access` for the refresh grant.
Verify the client URL domain and make the client public for external customers.
The implementation adds S256 PKCE and encrypts account-bound access and refresh
tokens. Tests use synthetic credentials, never staging or production grants.

Missing App configuration disables GitHub connection in the UI. Missing
encryption configuration disables Cloudflare credential entry. No PAT, SSH,
developer membership, or publisher-owned hosting fallback is used.

## Pilot acceptance

Use the [provider probe](customer-owned-publishing.md) to create three private
site repositories and Git-connected Pages projects. Repository creation and
publication must use only the customer installation token. Personal GitHub
sessions, developer membership, SSH keys, or the publisher's own Cloudflare
account are not fallback paths and do not count as customer onboarding evidence.

Verify Cloudflare cloned and built the intended commit, completed deployment,
and reports no Functions. Verify a generated `version-*` branch gets its own
preview while `main` remains unchanged. Test R2 upload and readback using the
customer's bucket credentials. Browser upload, public media delivery, tenant
authorization, full renderer compatibility, and portal integration are separate
gates before migrating a real customer site.

Typeroll remains the supported editor. Repositories contain generated source
and content for independent builds; manual repository edits are not imported
into the CMS.

### Correcting an unused media hostname

Publishing → Domains lets you replace a saved media hostname before it has
been verified or used. Select the Cloudflare domain, enter the corrected media
and sites subdomains, then select **Configure domains**. Typeroll checks the
organization's media records and earlier Git publications before saving.
Existing DNS destinations are never overwritten by this action.

Once media uses the hostname, keep it available for existing image links.
Replacing a used hostname requires a domain migration. The same check applies
to manual settings and authenticated API/MCP requests, including publications
on other version branches and media removed from the CMS.


## Additional Hosting Groups

Open **Settings → Publishing → Hosting Groups → Add Hosting Group**. Enter a
name and site address base such as `sites2.example.com`, create the group, and
select **Connect Cloudflare** to authorize its hosting account. No R2 subscription
or new media token is needed for additional hosting accounts. Media remains in
the organization's verified storage. Cloudflare's own GitHub integration must
also authorize the generated repositories in each hosting account.

Use **Site settings → Publishing → Hosting Group** to select a group before the
site's first publication. With only Default, no group selector is shown. Moving
an already published site requires an explicit hosting migration; changing this
selection never silently moves media or replaces a working deployment.

Choose **Use organization DNS connection** when Typeroll may manage DNS. It
looks for the hostname's zone in the organization connection, then the Hosting
Group connection. A site's DNS and Pages account may differ. Choose **My DNS
provider or agent** for externally managed records. Each hostname must be
registered with Pages before adding its CNAME. Proxied Cloudflare DNS is required
for custom branch addresses; confirm the returned publication identity before
considering a branch live.

API clients use `/api/v1/publishing/hosting-groups` to list, create, update and
connect groups with an organization key. POST `action: "connect"` with
`hosting_group_id`, the current connection `revision`, `account_id` and
`api_token` to use existing provider access instead of OAuth. Use `action:
"disconnect"` with the group ID and revision to disconnect hosting. Tokens never
appear in responses. Default's media/DNS connection stays in organization
Publishing. Site admins use `/api/v1/sites/{siteId}/publishing/hosting-group`
with `hosting_group_id` and `previous_group_id` to select an unpublished site's
group. Equivalent MCP tools are `list_hosting_groups`, `save_hosting_group`,
`connect_hosting_group`, `read_site_hosting_group`, and `set_site_hosting_group`.
