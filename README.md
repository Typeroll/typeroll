# Typeroll

Typeroll is an open-source CMS for building and operating fast static websites.
The repository contains the editor, public API, MCP server, Forms backend,
Extension runtime, static renderer, and self-hosting adapters as open-source
software. Most code is MIT-licensed; the WordPress helper plugin is
GPL-2.0-or-later for WordPress compatibility.

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
npm run typecheck
npm test
npm run build
```

See the [self-hosting guide](https://docs.typeroll.com/guides/self-hosting/)
for production configuration.

The supported Linux amd64 reference profile is defined in `compose.yaml`. It
runs portal, Forms, and worker roles from one immutable Core image digest,
uses Firestore as a durable deploy queue, and terminates TLS with Caddy. Start
by copying `.env.self-host.example` to `.env` and running
`npm run self-host:check`.

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
