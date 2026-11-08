import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';


// Portal is SSR by default and runs as a Cloudflare Worker (src/worker.ts,
// wrangler.jsonc). Marketing pages opt into static rendering with
// `export const prerender = true` inside the page.
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  // No Astro sessions: they would need a KV namespace, and customer data never
  // goes to KV.
  session: false,
  integrations: [react()],
  server: { port: 4321, host: true },
  // CSRF protection lives in src/middleware.ts now, not Astro's built-in
  // checkOrigin. The built-in unconditionally rejected bearer-authed API
  // calls (no Origin header on a curl/MCP DELETE), so we replaced it with
  // an origin check that exempts `Authorization: Bearer typeroll_live_*`
  // requests and the HMAC-protected /api/forms/submit endpoint. Cookie-
  // authed requests still need a matching Origin header — browsers send
  // that automatically on every state-changing fetch.
  security: { checkOrigin: false },
});
