// Settings tools. scripts_head, scripts_body_end, and custom_css ARE
// writable via the public API (as of mcp-server 0.4.x) — the v1 route
// accepts them and they round-trip through read_site_settings. Same
// trust model as user-authored block-type JS: a bearer-token caller
// takes responsibility for what they ship. The portal chat AI still
// doesn't expose these fields, so conversation-driven assistants can't
// smuggle scripts in.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const settingsTools: ToolDef[] = [
  {
    name: 'read_site_settings',
    description:
      "Read every site setting: name, tagline, logo, favicon/app icons, colors, fonts, contact info, social links, URL trailing-slash policy, iframe host allowlist, default SEO suffix/description, language, robots_txt, image_sizes_default, plus the scriptable surfaces scripts_head, scripts_body_end, and custom_css. Pass `version` to read a branch's settings (with copy-on-write chain-fallback to main for fields the branch hasn't overridden).",
    inputSchema: {
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'settings', v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'update_site_settings',
    description:
      'Patch site settings. Only the fields you pass change. ' +
      'Pass fields at the TOP LEVEL of the object — do NOT wrap in a "settings" key. ' +
      'Example: {"site_name": "Acme", "colors": {"primary": "#ff0"}} not {"settings": {...}}. ' +
      'Nested objects (colors, fonts, contact, social) are shallow-merged into the existing value. ' +
      'Unknown top-level keys return a 400 error listing the valid fields. ' +
      'scripts_head / scripts_body_end / custom_css ARE writable here — useful for a global stylesheet across all pages. ' +
      'Pass `version` to scope the write to a branch (copy-on-write) instead of main — the right way to brand/recolor a site inside a redesign branch (colors, fonts, logo, custom_css) without touching the live settings. Omit it to write main.',
    inputSchema: {
      version: versionParam,
      site_name: z.string().optional(),
      tagline: z.string().optional(),
      logo: z.string().optional(),
      favicon: z.string().optional(),
      apple_touch_icon: z.string().optional().describe('URL to a 180x180 PNG for iOS/Android home-screen bookmarks. Emitted as <link rel="apple-touch-icon">.'),
      icon_192: z.string().optional().describe('URL to a 192x192 PNG app icon. Emitted with sizes="192x192".'),
      trailing_slash: z.enum(['always', 'never', 'ignore']).optional().describe('Canonical URL style. `always` is the default; `never` emits extensionless URLs without a final slash; `ignore` preserves authored paths.'),
      iframe_allowed_hosts: z.array(z.string()).max(50).optional().describe('Additional exact HTTPS iframe hostnames allowed on this site, e.g. ["player.example.com"]. No wildcards, schemes, ports or paths.'),
      default_seo_suffix: z.string().optional(),
      default_meta_description: z.string().optional().describe('Site-wide fallback <meta name="description">. Used when a page has no seo_description of its own; falls back further to the tagline when unset.'),
      language: z.string().optional().describe('BCP-47 tag (e.g. "en", "sv", "en-GB"). Drives <html lang> on the rendered site.'),
      robots_txt: z.string().optional(),
      image_sizes_default: z.string().optional().describe('Site-wide default `sizes` attribute for responsive-image <picture> output, e.g. "(max-width: 640px) 360px, 560px". Tells the browser how wide images actually render so it stops over-fetching the larger srcset variant. A page can override via its own image_sizes_default; a per-<img> `sizes` attribute wins over both. Leave unset for the generic "(max-width: 768px) 100vw, 800px".'),
      // Scriptable surfaces. Trusted because the caller has an API key.
      scripts_head: z.string().optional().describe('Raw HTML injected into <head> on every page. Use for analytics, fonts, third-party CSS links.'),
      scripts_body_end: z.string().optional().describe('Raw HTML injected just before </body> on every page. Use for chat widgets, deferred analytics.'),
      custom_css: z.string().optional().describe('Global CSS shipped in <style> at the end of <head>. Lets you define site-wide design tokens (CSS variables, @media queries, :hover states) without inlining on every element.'),
      colors: z.record(z.string()).optional(),
      fonts: z.record(z.unknown()).optional(),
      contact: z
        .object({
          email: z.string().optional(),
          phone: z.string().optional(),
          // address can be a plain string (legacy) OR a structured
          // PostalAddress for rich Schema.org JSON-LD.
          address: z
            .union([
              z.string(),
              z.object({
                street_address: z.string().optional(),
                postal_code: z.string().optional(),
                address_locality: z.string().optional(),
                address_region: z.string().optional(),
                address_country: z.string().optional(),
              }).passthrough(),
            ])
            .optional(),
        })
        .passthrough()
        .optional(),
      social: z.record(z.string()).optional(),
      cookie_consent: z.object({
        enabled: z.boolean().optional(),
        text: z.string().optional().describe('Localized consent copy. May include a privacy-policy link.'),
        privacy_policy_url: z.string().optional(),
        scripts_necessary: z.string().optional().describe('Trusted script markup that runs before consent.'),
        scripts_optional: z.string().optional().describe('Trusted script markup activated only after full consent.'),
        reload_after_consent: z.boolean().optional(),
      }).optional().describe('Native consent banner configuration. Partial updates preserve omitted fields. Script fields execute in visitor browsers and are accepted under the API key authority.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.patch(siteId, 'settings', body, v(version));
      return ok(res);
    }),
  },
];
