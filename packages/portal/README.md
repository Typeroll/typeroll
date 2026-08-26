# @typeroll/portal

The Astro SSR + React app. Where users edit content, run workflows, chat with the AI.

## Conventions

### Every API route uses the access helper

```ts
import { requireSiteAccess, json } from '../../../../lib/access';

export const PUT: APIRoute = async ({ request, cookies, params }) => {
  const guard = await requireSiteAccess(cookies, params.siteId);
  if (!guard.ok) return guard.response;
  const { session, site } = guard.value;
  // session.orgId and site.id are now trustworthy.
};
```

If your route doesn't take a `siteId`, use `requireSession`. Don't roll your own auth checks.

### Whitelist updatable fields

When accepting JSON for a write, build an explicit allow-list of which fields to forward to the store. Never spread `body` into a doc directly. This is how the page editor, collection items, settings, and AI tools all guard against rogue field writes.

### React components mount with `client:load`

UI lives in `src/components/*.tsx`. Astro page wrappers in `src/pages/app/...` import the component and pass server-loaded props down. The component owns its data fetching to its own API routes via `fetch`.

### File layout

```
src/
├── pages/
│   ├── index.astro                Marketing home (prerender: true)
│   ├── pricing.astro              (prerender: true)
│   ├── login.astro
│   ├── app/                       Authenticated routes
│   │   ├── index.astro            Dashboard
│   │   ├── settings/              Account settings
│   │   └── sites/
│   │       ├── new.astro
│   │       └── [siteId]/          Per-site routes
│   │           ├── index.astro    Site dashboard
│   │           ├── pages/
│   │           ├── collections/
│   │           ├── partials/      Header/footer editor
│   │           ├── media.astro
│   │           ├── redirects.astro
│   │           ├── migration.astro WP migration URL coverage analyzer
│   │           ├── workflows/
│   │           ├── ai.astro       Chat UI
│   │           └── settings.astro
│   └── api/                       JSON + form-POST endpoints
│       ├── auth/
│       ├── sites/
│       │   ├── create.ts
│       │   ├── create-and-migrate.ts
│       │   ├── create-and-plan.ts
│       │   └── [siteId]/          Per-site mutations (incl. migration-urls)
│       └── forms/submit.ts        CORS endpoint static sites POST to
├── components/                    React, mounted with client:load
├── layouts/                       Astro
└── lib/
    ├── access.ts                  ★ Auth + tenancy guards
    ├── auth.ts                    Firebase session cookies
    ├── datastore.ts               Read+write store (Firestore | fixtures)
    ├── anthropic.ts               ★ Chat tool loop + system prompt
    ├── sanitize.ts                Customer HTML policy (mirrors site-template)
    ├── render-preview.ts          In-portal HTML renderer for editor iframe
    ├── workflows/                 Workflow engine + 9 workflow types
    ├── wp/                        WordPress migration internals: REST client,
    │                              helper-plugin client, HTML cleaner,
    │                              AI reconstruction, custom-types schema
    │                              inference, JIT media transfer, sitemap +
    │                              internal-links + URL inventory analyzer
    ├── deploy/                    runDeploy orchestrator
    ├── hosting/                   HostingAdapter interface + CF Pages impl
    ├── ai/                        Claude wrapper for workflows (NOT the chat)
    ├── forms-signing.ts           HMAC tokens for public form submissions
    └── rate-limit.ts              In-memory sliding-window rate limiter
```

## Astro config

`output: 'server'` (SSR). Marketing pages opt into static with `export const prerender = true`. The Node adapter is used for both dev and production builds.

CSRF: `security.checkOrigin: true` is set. `allowedDomains` must include every host the portal is served on — otherwise Astro's URL falls back to bare "localhost" without the port and Origin checks fail.

## Environment

See `.env.example` for the full list. The portal runs without any of them — fixtures backend + dev session + chat returning a no-key explanation. Set them when you need real Firebase / Anthropic / R2 / Cloudflare Pages.

See the root [`AGENTS.md`](../../AGENTS.md) and [`docs/`](../../docs/) for the
repository rules, architecture, security model, and operational guides.
