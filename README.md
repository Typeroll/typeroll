# Typeroll CMS

Typeroll CMS is an open-source CMS for static websites, with AI-agent workflows
and a client-friendly visual editor for managing multiple client sites.

Freelancers and web agencies can build and manage client websites with their own
AI agents, then give clients access to edit content in the browser. Organizations
can also use Typeroll CMS to manage their own websites. Self-host or use Typeroll Cloud.

The repository contains the editor, public API, MCP server, Forms backend,
Extension runtime, static renderer, and self-hosting adapters as open-source
software. Most code is MIT-licensed; the WordPress helper plugin is
GPL-2.0-or-later for WordPress compatibility.

AI agents can connect through MCP using a supported HTTP or stdio client, or
call the REST API directly. See [client compatibility and verification status](packages/docs-site/src/content/docs/getting-started/client-compatibility.mdx)
and the [connection guide](packages/docs-site/src/content/docs/getting-started/mcp-server.mdx).

## What is included

- block and HTML page editing with live preview;
- collections, reusable blocks, media, redirects, templates, and workflows;
- server-backed Forms with stored submissions, email actions, and webhooks;
- the Extension manifest, installation, admin SSO, and browser runtime;
- the WordPress migration workflow, URL coverage tools, and helper plugin;
- a REST API and `@typeroll/mcp-server` for agent-driven site management;
- static site generation and Cloudflare Pages deployment support;
- Firebase/Firestore, R2, and local fixture-store adapters.

Forms is a core module in both the open-source edition and Typeroll Cloud. A
self-hosted installation stores submissions in its own datastore and sends
notifications and webhooks through services configured by its operator.

## Repository layout

```text
packages/shared/         Shared data contracts and block renderer
packages/site-template/  Astro static site generator
packages/portal/         Astro/React CMS, API, Forms, and Extension runtime
packages/mcp-server/     Public MCP server and CLI
packages/docs-site/      Public documentation
wp-helper-plugin/         Read-only WordPress migration helper
examples/                Extension examples
```

## Quick start

Use Node.js 22 or later.

```sh
npm install
npm run dev:portal
```

The development server uses the fixture datastore and a local development
identity when Firebase is not configured. Open `http://localhost:4321`.

Run the static renderer separately with:

```sh
npm run dev:site
```

Before contributing, run:

```sh
node scripts/oss-release-check.mjs
```

Maintainer releases use one ordered train after successful CI on public
`main`: immutable Core image and tag, MCP package and tag, public docs, then a
Cloud-consumable release manifest. See [docs/releasing.md](docs/releasing.md).

See the [self-hosting guide](https://typeroll.com/docs/guides/self-hosting/)
for production configuration.

The supported production reference profile is fully serverless in a
customer-owned GCP/Firebase project: Cloud Run hosts portal and Forms, Cloud
Tasks invokes deploy work, and Cloud Scheduler invokes publish sweeps. It uses
one immutable Core image digest and Application Default Credentials, with no
VM, service-account key, or always-running worker. Start with
`config/self-host-gcp.example.json`, then run `npm run self-host:gcp:plan` and
the dry-run-first `npm run self-host:gcp:apply`. The read-only
`npm run self-host:gcp:doctor` verifies the control plane without reading
secret values. `compose.yaml` remains a portable fallback, not the supported
production profile. See the self-hosting guide before changing remote
resources.

## Cloud and premium products

Typeroll Cloud is the managed distribution operated from the private
`Typeroll/typeroll-cloud` repository. Its deployment automation, operator
console, marketing site, and operational configuration are not part of this
repository. The migration code is open source; Typeroll Cloud can provide its
execution, infrastructure, and support as a managed service.

Typeroll Apps are separately operated premium applications. They connect to
either Typeroll Cloud or a self-hosted installation through the same open
Extension protocol. Third-party Extensions remain hosted in their developers'
own accounts.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue for an undisclosed vulnerability.

## License

Most of the repository is [MIT-licensed](LICENSE). The WordPress helper plugin
is distributed under
[GPL-2.0-or-later](wp-helper-plugin/LICENSE).
