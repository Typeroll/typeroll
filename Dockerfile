# Multi-stage build for the Typeroll portal.
#
# Stage 1 (deps) installs the entire workspace once — used both for the
# build step and for copying the runtime node_modules into the final image.
# Workspace packages are symlinked into node_modules so the portal can
# resolve @typeroll/shared at runtime.
#
# Stage 2 (builder) runs `astro build` against the portal package.
#
# Stage 3 (runtime) is the final image: Node + the portal's dist + the
# site-template package + workspace node_modules. The portal SSR process
# spawns `astro build` inside the container during deploys, so the
# site-template + astro CLI must be present.

# ─── Stage 1: deps ─────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /repo

# Workspace declaration first so Docker layer-caching skips re-install
# when only source changes. tsconfig.base.json is referenced by every
# package's tsconfig.json via `extends`; without it astro build fails
# during the type pass.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/portal/package.json packages/portal/
COPY packages/shared/package.json packages/shared/
COPY packages/site-template/package.json packages/site-template/
# Portal's hosted-MCP route imports @typeroll/mcp-server/server, so the
# mcp-server workspace has to be present at install + build time. Its
# stdio entry isn't used by the portal but resolving the export map
# requires the full package.
COPY packages/mcp-server/package.json packages/mcp-server/
# Docs site requires Astro 6 which the portal's package-lock doesn't
# resolve cleanly inside this image; provide a stub package.json (the
# docs site is built separately by the Docs workflow).
COPY packages/docs-site/package.json packages/docs-site/

RUN npm ci --workspaces --include-workspace-root

# ─── Stage 2: builder ──────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /repo

COPY packages/shared/ packages/shared/
COPY packages/portal/ packages/portal/
COPY packages/site-template/ packages/site-template/
# Source for @typeroll/mcp-server/server — imported by the hosted-MCP
# route. The "./server" export points at src/server.ts so we need the
# real source, not just the package.json stub.
COPY packages/mcp-server/ packages/mcp-server/

# Vite resolves `import.meta.env.PUBLIC_*` at build time and inlines the
# values into the browser bundle. So Firebase client config has to be
# present in the environment WHEN astro build runs — Cloud Run env vars
# set at deploy time arrive too late. These are public values (apiKey
# included; Firebase considers it safe to ship in HTML) so they go in
# the image, not Secret Manager.
ARG PUBLIC_FIREBASE_API_KEY
ARG PUBLIC_FIREBASE_AUTH_DOMAIN
ARG PUBLIC_FIREBASE_PROJECT_ID
ARG PUBLIC_FIREBASE_APP_ID
ENV PUBLIC_FIREBASE_API_KEY=$PUBLIC_FIREBASE_API_KEY \
    PUBLIC_FIREBASE_AUTH_DOMAIN=$PUBLIC_FIREBASE_AUTH_DOMAIN \
    PUBLIC_FIREBASE_PROJECT_ID=$PUBLIC_FIREBASE_PROJECT_ID \
    PUBLIC_FIREBASE_APP_ID=$PUBLIC_FIREBASE_APP_ID

WORKDIR /repo/packages/portal
RUN npm run build

# ─── Stage 3: runtime ──────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run injects PORT; default for local docker runs.
ENV PORT=8080
ENV HOST=0.0.0.0

# Copy the entire repo tree (node_modules + built portal + site-template).
# We keep the monorepo shape because runDeploy spawns `astro build`
# against packages/site-template at runtime — that needs its source +
# node_modules in place, not just the portal's dist.
COPY --from=builder /repo /app

EXPOSE 8080
WORKDIR /app/packages/portal
CMD ["node", "./dist/server/entry.mjs"]
