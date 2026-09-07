# Connect customer-owned publishing accounts

Status: organization account connection is implemented. Core 0.1.20 simplifies
GitHub organization discovery. Customer acceptance remains pending.
Automatic site provisioning and editor publication are still being implemented.
See [implementation status](customer-owned-publishing.md).

The customer or agency owns the GitHub organization, publication repositories,
Cloudflare account, and media storage. The publisher receives access through a
GitHub App installation and scoped Cloudflare credentials. Customers do not
invite the publisher's developers or share a personal GitHub token.

One organization and account connection is reused for multiple sites. Each
site receives a private generated repository and a Git-connected Pages project.
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
**Connect Cloudflare**. Sign in to Cloudflare and approve access to your agency's
account. Typeroll discovers authorized accounts; choose one if several are
available. You do not need to type an account name or Account ID or create a
general API token for this connection. Reuse the connection for all sites in
the Typeroll organization.

The publisher must configure a public Cloudflare OAuth client first. A private
client only accepts members of the publisher's own Cloudflare account, which
does not reproduce external customer onboarding.

For image storage, select **Prepare media storage**. Typeroll prepares one R2
bucket for the organization and configures direct browser upload access. If R2
is inactive, open **Cloudflare → your account → Storage & databases → R2 object
storage → Overview** and complete activation. Cloudflare may request billing
details; account activation is the customer's action.

Direct uploads require a separate S3 key pair. In **R2 object storage → Overview
→ Account Details**, select **Manage** next to **API Tokens**. Create an R2
token with **Object Read & Write** limited to the bucket shown in Typeroll.
Copy its **Access Key ID** and **Secret Access Key** into Typeroll and select
**Verify image uploads**. These credentials are added once per organization.
Typeroll verifies write, read and delete access and stores the keys encrypted.

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

## R2 media credentials

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
