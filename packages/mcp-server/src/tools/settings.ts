// Settings tools. update_site_settings accepts every field the portal
// Settings form does — including scripts_head, scripts_body_end,
// custom_css, cookie-consent scripts, default_og_image, twitter_handle,
// organization (JSON-LD) and staging_url — with the same admin permission
// the portal requires. A bearer-token caller takes responsibility for what
// it ships, exactly as a site admin in the portal does. (The in-portal chat
// assistant has its own, narrower settings tool; that is unrelated to MCP.)

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const settingsTools: ToolDef[] = [
  {
    name: 'read_site_settings',
    description:
      "Read every site setting: name, tagline, logo, favicon/app icons, colors, fonts, contact info, social links, URL trailing-slash policy, iframe host allowlist, default SEO suffix/description, default_og_image, twitter_handle, organization (JSON-LD), language, robots_txt, image_sizes_default, cookie_consent, plus the scriptable surfaces scripts_head, scripts_body_end, and custom_css, `urls` (including `urls.staging`, the site's staging_url) and `render` (the site's platform render version, the latest version and what upgrading would change). Pass `version` to read a branch's settings (with copy-on-write chain-fallback to main for fields the branch hasn't overridden).",
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
      'Patch site settings, including responsive breakpoints for block layouts and visibility. Accepts everything the portal Settings form does. Requires admin permission on the site, as in the portal. Only the fields you pass change. ' +
      'Pass fields at the TOP LEVEL of the object — do NOT wrap in a "settings" key. ' +
      'Example: {"site_name": "Acme", "colors": {"primary": "#ff0"}} not {"settings": {...}}. ' +
      'Nested objects (colors, fonts, contact, social) are shallow-merged into the existing value. ' +
      'Unknown top-level keys return a 400 error listing the valid fields. ' +
      'scripts_head / scripts_body_end / custom_css and cookie_consent scripts ARE writable here — useful for a global stylesheet or analytics tag across all pages. ' +
      'Social sharing and structured data: default_og_image, twitter_handle, organization ({name, logo, same_as[]}, replaced as a whole; null clears). ' +
      'staging_url is stored on the Site (not per version), so it applies whichever `version` you pass. ' +
      'Pass `version` to scope the write to a branch (copy-on-write) instead of main — the right way to brand/recolor a site inside a redesign branch (colors, fonts, logo, custom_css) without touching the live settings. Omit it to write main.',
    inputSchema: {
      version: versionParam,
      responsive_breakpoints: z.object({ tablet: z.number().int().min(320).max(2560), laptop: z.number().int().min(320).max(2560), desktop: z.number().int().min(320).max(2560), wide: z.number().int().min(320).max(2560) }).strict().nullable().optional().describe('Increasing viewport widths for authored responsive block fields and hidden_on. All four required; null restores defaults. Menu collapse remains explicit.'),
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
      sitewide_noindex: z.boolean().optional().describe('Exclude public pages from search indexing; following links remains a separate setting.'),
      external_routes: z.array(z.object({ path: z.string().min(2).max(2048), owner: z.string().min(1).max(200) }).strict()).max(1000).optional().describe('Exact same-origin paths owned by an independent deployment, e.g. [{path:"/docs/",owner:"Documentation"}]. No wildcards. Does not configure hosting or verify remote availability. Verify each declared public URL separately. Local routes cannot be exempted.'),
      seo_review: z.object({ forbidden_markers: z.array(z.string().min(1).max(500)).max(100).optional(), claims: z.array(z.object({ phrase: z.string().min(1).max(500), guidance: z.string().min(1).max(500) })).max(100).optional(), notes: z.array(z.string().min(1).max(500)).max(100).optional() }).optional().describe('Editorial review rules checked on all built pages, including unchanged pages. Warnings require human review; no copy is rewritten.'),
      sitewide_nofollow: z.boolean().optional().describe('Ask search engines not to follow links. Defaults to false.'),
      image_sizes_default: z.string().optional().describe('Site-wide default `sizes` attribute for responsive-image <picture> output, e.g. "(max-width: 640px) 360px, 560px". Tells the browser how wide images actually render so it stops over-fetching the larger srcset variant. A page can override via its own image_sizes_default; a per-<img> `sizes` attribute wins over both. Leave unset for the generic "(max-width: 768px) 100vw, 800px".'),
      // Scriptable surfaces. Trusted because the caller has an API key.
      scripts_head: z.string().optional().describe('Raw HTML injected into <head> on every page. Use for analytics, fonts, third-party CSS links.'),
      scripts_body_end: z.string().optional().describe('Raw HTML injected just before </body> on every page. Use for chat widgets, deferred analytics.'),
      custom_css: z.string().optional().describe('Global CSS in a <style> in <head>, after block CSS and before the page\'s own custom CSS and the template base stylesheet (reset + global). Base rules for :root tokens (spacing, radius, container widths), body font and line-height load after it, so override those with a more specific selector (for example html:root or body.page) rather than a bare :root/body rule. Preview uses the same order. Lets you define site-wide design tokens (CSS variables, @media queries, :hover states) without inlining on every element. Prefer named styles (create_style) for anything a style can express. Syntax errors (unbalanced braces, unclosed comments or strings, expression()/javascript:) refuse the write; selectors on platform markup ([data-block], .block-*) come back as warnings because they can change between render versions — target s-<style> classes or block custom_class instead.'),
      default_og_image: z.string().optional().describe('Site-wide fallback og:image URL for pages without their own social image. Empty string clears.'),
      twitter_handle: z.string().optional().describe('Twitter/X handle for twitter:site, with or without the leading @ (stored without it). Empty string clears.'),
      organization: z.object({
        name: z.string().optional(),
        logo: z.string().optional().describe('Absolute logo URL for the Organization JSON-LD.'),
        same_as: z.array(z.string()).max(50).optional().describe('Profile URLs (LinkedIn, X, Facebook, …) emitted as sameAs.'),
      }).strict().nullable().optional().describe('Organization schema.org JSON-LD emitted on every page. Replaces the stored value as a whole; null (or all-empty) clears it.'),
      staging_url: z.string().nullable().optional().describe('URL of a staging environment for this site, reported as urls.staging. Stored on the Site, not per version. Trailing slashes are dropped; empty string or null clears.'),
      render_version: z.number().int().min(1).optional().describe('Platform render version. Platform output changes ship as new versions so existing sites never change look on their own. Upgrade only after previewing (get_preview_link render_version) and with the user\'s approval; the tr-upgrade-rendering skill compares every page. Lowering it returns to an earlier version.'),
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
