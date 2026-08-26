// Typeroll data model.
//
// HTML page mode is the only mode currently implemented end-to-end.
// Block mode types are defined here so the data shape is stable from day one,
// but the renderer and editor only handle HTML mode.

import type { HreflangAlternate } from './hreflang.js';

// ─── Auth & Tenancy ──────────────────────────────────────────────────────

export type Plan = 'free' | 'starter' | 'pro' | 'agency' | 'enterprise';
export type MemberRole = 'owner' | 'admin' | 'editor';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  plan: Plan;
  /**
   * Opt in to enforcing `Member.role`. OFF by default, and deliberately so:
   * roles have been written to member docs since orgs shipped (owner on
   * create, editor on invite-join) but never read, so every member has held
   * full authority. Enforcing globally on deploy would demote every invited
   * member at once — including orgs whose only 'owner' has since left, which
   * would lock the rest out of their own settings. Flipping this is an
   * explicit act per org. See lib/member-role.ts.
   */
  roles_enforced?: boolean;
  api_keys?: {
    anthropic?: string;
    dataforseo_login?: string;
    dataforseo_password?: string;
    google_service_account?: string;
    cloudflare_api_token?: string;
  };
  white_label?: {
    enabled: boolean;
    custom_domain?: string;
    logo?: string;
    primary_color?: string;
    support_email?: string;
  };
  created_at: string;
}

export interface Member {
  id: string;
  email: string;
  role: MemberRole;
  firebase_uid: string;
  display_name?: string;
  joined_at: string;
}

// `SiteStatus` was removed in 0.30.0. It was a lifecycle label
// ('planning' | 'migrating' | 'staging' | 'live' | 'paused') written once at
// site creation and never advanced — 'live', 'staging' and 'paused' were
// unreachable in practice — so it drifted from reality and misreported sites
// that were serving real traffic as 'planning'.
//
// Use `domain_status` for "is this site actually serving" (it's maintained by
// the domain lifecycle), or the site's deploy history for "has anything been
// published". Existing Firestore docs keep the stale field; nothing reads it.

/**
 * Every site has at least one "version" — `main` — that powers the production
 * deploy. Additional versions are branches: deep-copies of main's content
 * (pages, partials, settings, redirects, collections, chat) that customers use
 * for redesigns, seasonal campaigns, or trial migrations before promoting back
 * to main.
 *
 * Media, forms, and submissions live one level up (per-site, not per-version)
 * — images don't get re-uploaded for every branch.
 */
export type SiteVersionKind = 'main' | 'branch';
export const MAIN_VERSION_ID = 'main' as const;

export interface SiteVersion {
  id: string;                // 'main' for the canonical version, kebab-case for branches
  name: string;              // display name ("Main", "Spring 2026 redesign")
  kind: SiteVersionKind;     // 'main' is unique per site; everything else is 'branch'
  /**
   * The version this branch reads through when it doesn't have a local
   * override for a doc. Copy-on-write: a branch starts empty, every read
   * falls back to base_version_id (and recursively up the chain to main).
   * Only branches have this set; main resolves to itself.
   */
  base_version_id?: string;
  created_at: string;
  created_by?: string;
  /** Branches default to robots-blocked; main is always indexable. */
  robots_blocked?: boolean;
  /**
   * Where this version is currently deployed. Main typically derives from
   * site.domain so this is empty; branches need an explicit URL (e.g. a
   * per-branch Cloudflare Pages preview) before any "Live" link can be
   * shown for content on the branch.
   */
  deploy_url?: string;
  /** ISO timestamp of the last successful runDeploy call on this version.
   *  Anything written more recently than this is "pending deploy". */
  last_deployed_at?: string;
}
export type HostingAdapterName = 'cloudflare' | 'netlify' | 'vercel' | 'firebase' | 'custom';

export interface Site {
  id: string;
  name: string;
  /**
   * Anonymous, random short id (10 chars, [0-9a-z]) used as the PUBLIC media
   * R2-key prefix: `media/{media_id}/{filename}`. Deliberately NOT the org or
   * the site slug — media URLs are public, so a name-derived id would leak the
   * customer/agency, and keying by org would break when a site moves between
   * orgs. This id belongs to the SITE and travels with it. Generated at site
   * creation; lazily backfilled on first upload for sites created before this
   * field. See `lib/media-keys.ts`.
   */
  media_id?: string;
  /**
   * URL-stable identifier separate from `id`. Drives the fallback
   * subdomain (`{slug}.{SITES_BASE_DOMAIN}`) so external tooling can
   * reference a site by a human-readable name even when the underlying
   * doc id is opaque. When omitted, the site falls back to using `id`
   * for the same role (legacy behaviour). Lowercase kebab-case,
   * 3-48 chars, [a-z0-9-], uniqueness enforced per-org at write time.
   */
  slug?: string;
  /**
   * Customer's intended hostname (e.g. `www.autopilot.se`). Just the
   * intention — the live URL only points here when `domain_status` is
   * `'live'`. See domain_status below + docs/domain-lifecycle-plan.md.
   */
  domain?: string;
  /**
   * Lifecycle of the custom domain. Drives whether `publicUrlsFor`
   * surfaces the domain as the production URL.
   *
   *  - `pending`   — domain added, DNS not yet pointing at us (or cert
   *                  not yet issued by Cloudflare).
   *  - `verified`  — Cloudflare reports DNS is correct + cert is issued.
   *                  Ready to switch over, but the customer hasn't
   *                  explicitly activated yet.
   *  - `live`      — customer activated. `publicUrlsFor.production`
   *                  returns the domain URL.
   *  - `failed`    — Cloudflare returned an unrecoverable status
   *                  (blocked / error). `domain_failure_reason` carries
   *                  the human-readable hint.
   *
   * Legacy compatibility: when `domain` is set but `domain_status` is
   * undefined, resolvers treat it as `'live'` ONLY if `domain_verified_at`
   * is present — otherwise `'pending'`. A bare domain with no lifecycle
   * fields at all means the domain was written by a path that bypassed
   * requestDomain (it was never registered on Cloudflare Pages), and must
   * never be presented as live/verified.
   */
  domain_status?: 'pending' | 'verified' | 'live' | 'failed';
  /** ISO timestamp recorded when the domain was first added to the site. */
  domain_added_at?: string;
  /** ISO timestamp recorded when Cloudflare last reported the domain as
   *  active (status `verified` or `live`). */
  domain_verified_at?: string;
  /** CNAME target the customer must point DNS at — derived from the
   *  Cloudflare Pages project name. The settings UI renders this as
   *  the DNS instruction. */
  domain_dns_target?: string;
  /** Human-readable reason when `domain_status === 'failed'`. Surfaced
   *  in the UI; safe to display verbatim. */
  domain_failure_reason?: string;
  /**
   * The sister hostname registered alongside `domain` on the same
   * Cloudflare Pages project. When the customer adds `example.com`
   * (apex), this is automatically set to `www.example.com` and a 301
   * redirect alias → canonical is emitted into `_redirects` at deploy
   * time. When they add `www.example.com`, this becomes `example.com`.
   * When they add a non-pair subdomain like `app.example.com`, this
   * stays undefined (single-domain flow).
   *
   * The pair invariant matters: Cloudflare Pages routes by Host header
   * against the registered-domain list. A project that's only registered
   * for one variant returns 522 for the other. Registering both is
   * non-negotiable for any apex/www pair — see [`domain-pair.ts`](
   * packages/portal/src/lib/domain-pair.ts) for the classifier.
   */
  domain_alias?: string;
  /**
   * Status of the alias variant on Cloudflare. Mirrors `domain_status`
   * but for `domain_alias`. The site can't go `live` overall until both
   * the canonical and the alias report `verified` — pollDomainStatus
   * applies the worst-of-two rule.
   */
  domain_alias_status?: 'pending' | 'verified' | 'live' | 'failed';
  /** Per-alias failure reason (e.g. DNS not pointed at us yet for that
   *  variant). Shown next to the alias badge in the UI. */
  domain_alias_failure_reason?: string;
  /**
   * Which variant is canonical when an apex/www pair is registered.
   * `apex` (default) means `example.com` is canonical and `www.*`
   * 301s to it; `www` means the reverse. Stored explicitly so
   * activateDomain knows which way to point the cross-host redirect
   * even if the user later flips the preference.
   */
  domain_canonical?: 'apex' | 'www';
  staging_url?: string;
  source_wp_url?: string | null;
  source_builder?: 'elementor' | 'breakdance' | 'gutenberg' | 'classic' | 'none';
  hosting_adapter: HostingAdapterName;
  /** Adapter-specific config. For cloudflare: `{ pages_project, fallback_subdomain }`.
   *  Created on site provisioning. */
  hosting_config?: {
    pages_project?: string;
    /** Auto-provisioned `<slug>.sites.typeroll.com`-style host so the
     *  customer can preview before pointing their real DNS at us. */
    fallback_subdomain?: string;
  } & Record<string, unknown>;
  /**
   * Default content language of the site, expressed as a BCP-47 tag
   * (`en`, `sv`, `en-GB`, `de-CH`). Used by the renderer to emit
   * `<html lang>` and by alt-text generation to write in the right
   * language. Defaults to `en` when omitted. Per-page language overrides
   * via `Page.language` (e.g. a single English page on an otherwise
   * Swedish site).
   */
  language?: string;
  /**
   * Allows agent surfaces (MCP tools, chat AI, API-key writes) to author
   * the `script` field on custom BlockTypes for this site. OFF by default:
   * an agent that reads untrusted content (migrated pages, web research)
   * can be prompt-injected into shipping malicious JS to every visitor —
   * a human author can't. Flipping this is an explicit, per-site human
   * decision made in the portal (Settings → Custom code), same consent
   * model as the BlockTypeEditor's "Activate JS" toggle. When off,
   * agent-surface writes silently strip `script` and surface a warning.
   */
  ai_scripts_enabled?: boolean;
  r2_path_prefix?: string;
  cdn_url?: string;
  created_at: string;
  /**
   * Publish content changes automatically instead of waiting for someone to
   * press Deploy. OFF by default — an existing site must never start
   * deploying on its own because the platform gained the ability.
   *
   * Writes stamp `pending_deploy_at`; the publish sweep enqueues ONE build
   * per site whose marker is older than the debounce window, so an agent
   * writing 40 records produces one deploy rather than forty.
   */
  auto_deploy?: {
    enabled: boolean;
    /** How long to let edits accumulate before building. Default 15. */
    debounce_minutes?: number;
  };
  /**
   * When the FIRST unpublished content change landed. Set only if not
   * already set — it measures the age of the oldest pending edit, which is
   * what a debounce window is actually about. Cleared when a deploy is
   * enqueued; a write during the build re-sets it, so nothing is lost.
   */
  pending_deploy_at?: string | null;
}

// ─── Site Settings ───────────────────────────────────────────────────────

export interface SiteSettings {
  site_name: string;
  tagline?: string;
  logo?: string;
  favicon?: string;
  /** 180×180 PNG used by iOS/Android home-screen bookmarks. Emitted as
   *  <link rel="apple-touch-icon"> when set. Brand kits usually ship one
   *  (e.g. an app icon export) — set it alongside favicon. */
  apple_touch_icon?: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    text_light: string;
  };
  fonts: {
    heading: string;
    body: string;
    size_base: number;
  };
  contact?: {
    email?: string;
    phone?: string;
    /**
     * Postal address. Accepts two shapes:
     *
     *   1. Plain string  — legacy form, single rendered line. Continues to
     *      work for sites that use a freeform address. The renderer emits
     *      it as-is inside an <address> element with no structured data.
     *
     *   2. Structured object matching Schema.org PostalAddress. The renderer
     *      uses these to emit JSON-LD with full street_address / postal_code
     *      / locality so search engines pick it up cleanly. Field names
     *      match Schema.org's so the JSON-LD generation is a 1:1 mapping.
     */
    address?: string | PostalAddress;
  };
  social?: {
    facebook?: string;
    instagram?: string;
    linkedin?: string;
    x?: string;
    youtube?: string;
  };
  scripts_head?: string;
  scripts_body_end?: string;
  custom_css?: string;
  /**
   * Optional cookie-consent banner. When `enabled`, the renderer injects a
   * blocking modal that asks the visitor to accept/reject before any scripts
   * placed in `scripts_optional` run. `scripts_necessary` run unconditionally
   * (the legal "strictly necessary" tier — typically Consent Mode v2 defaults).
   *
   * The page DOM is rendered fully even when the modal is up — only a CSS
   * overlay sits on top — so crawlers see the underlying content (Googlebot
   * never accepts cookies). The visitor's choice is stored in a first-party
   * cookie (`tr_consent` = `all` | `necessary` | `rejected`, 12-month TTL).
   *
   * NEVER expose `scripts_*` or `text` through the AI chat tool surface — they
   * are scriptable / HTML-injected via set:html. Mirror the existing
   * `scripts_head` discipline.
   */
  cookie_consent?: CookieConsentSettings;
  /** BCP 47 language tag for <html lang>, e.g. "sv", "en", "en-GB". Default "en". */
  language?: string;
  /** Optional Twitter/X handle used for twitter:site card meta (without the @). */
  twitter_handle?: string;
  default_seo_suffix?: string;
  /** Fallback meta description when a page hasn't set its own. */
  default_meta_description?: string;
  /**
   * Site-wide default `sizes` attribute for responsive-image `<picture>`
   * output, applied by the SEO transform when neither the individual `<img>`
   * nor the page (`Page.image_sizes_default`) specifies one. Precedence:
   * per-image `sizes` > page default > this site default > the built-in
   * generic fallback. Set this when most images on the site render at a
   * predictable width narrower than the generic "100vw / 800px" assumption.
   */
  image_sizes_default?: string;
  /** Fallback OpenGraph image URL (used by Page.og_image lookup). */
  default_og_image?: string;
  /** Organization schema info — emitted as JSON-LD on the site. */
  organization?: {
    name?: string;
    logo?: string;
    /** Profile URLs (LinkedIn, Twitter/X, Facebook, …) included as sameAs. */
    same_as?: string[];
  };
  robots_txt?: string;
}

/**
 * Schema.org PostalAddress shape. Used by SiteSettings.contact.address when
 * the customer wants structured data instead of a freeform string.
 * Field names are snake_case mirrors of the Schema.org PostalAddress
 * properties (streetAddress → street_address, etc.) so the renderer's
 * JSON-LD generation is a direct 1:1 mapping with camelCase fixups.
 */
export interface PostalAddress {
  /** Multi-line street part: "Main Street 12", "Storgatan 5, vån 3". */
  street_address?: string;
  /** ZIP / postal code: "10001", "11432". */
  postal_code?: string;
  /** City / town: "New York", "Stockholm". */
  address_locality?: string;
  /** Province / state / region: "NY", "Stockholms län". */
  address_region?: string;
  /** ISO 3166-1 alpha-2 country code: "SE", "US", "DE". */
  address_country?: string;
}

/**
 * Cookie-consent banner config. See SiteSettings.cookie_consent for the full
 * docs. Three buttons in the modal map to three cookie values:
 *
 *   "Godkänn alla"        → tr_consent=all       → scripts_optional run
 *   "Endast nödvändiga"   → tr_consent=necessary → no optional scripts
 *   "Neka"                → tr_consent=rejected  → no optional scripts
 *
 * "Endast nödvändiga" and "Neka" are functionally identical from the
 * platform's perspective (we don't run optional scripts in either case),
 * but we record the distinct value so analytics can tell consent-blocked
 * visitors from rejection-blocked ones if needed.
 */
export interface CookieConsentSettings {
  enabled: boolean;
  /**
   * HTML body of the modal — describes what the site uses cookies for and
   * usually includes an anchor to the privacy policy. Sanitised at render
   * time like any other customer HTML. Plain text is fine; the editor
   * provides a textarea so site owners can paste `<a href>` links.
   */
  text?: string;
  /**
   * Optional convenience: an explicit privacy-policy URL the editor uses
   * to render a "Read more" link below the body text. Site owners can
   * instead include the link in `text` and leave this blank.
   */
  privacy_policy_url?: string;
  /**
   * Scripts injected as-is into <head> on every page load, regardless of
   * the visitor's choice. Use for things that work without consent: a
   * server-side analytics pixel, a Consent Mode v2 default-denied block
   * that GTM consumes, security/anti-fraud scripts. Same security model
   * as `scripts_head` — set:html injected, never exposed to the AI tool
   * surface.
   */
  scripts_necessary?: string;
  /**
   * Scripts run ONLY after the visitor clicks "Godkänn alla". Rendered
   * into the page as `<script type="text/plain" data-tr-consent="optional">`
   * so the browser ignores them on first paint; the gate script swaps
   * `type` to `text/javascript` and re-injects the elements once consent
   * is granted (either on the current page or on subsequent loads when
   * the cookie is already set to `all`).
   */
  scripts_optional?: string;
  /**
   * Opt-in fallback for sites whose optional scripts misbehave when
   * injected mid-page (legacy GTM containers, some chat widgets). When
   * true, the modal triggers `location.reload()` after setting the cookie
   * instead of doing in-place script activation. The reload happens once
   * per consent choice — subsequent page loads see the cookie and skip
   * the modal entirely.
   */
  reload_after_consent?: boolean;
}

// ─── Global blocks (header / footer / free) ──────────────────────────────

export type ContentMode = 'blocks' | 'html';
/**
 * 'header' and 'footer' are auto-injected by the renderer (one published doc of
 * each kind is included on every page). 'free' blocks are inserted explicitly
 * via <x-include name="{id}" /> in a page's HTML body.
 */
export type PartialKind = 'header' | 'footer' | 'free';
export type PartialStatus = 'draft' | 'published';

export interface Partial {
  id: string;
  name: string;
  kind: PartialKind;
  content_mode: ContentMode;
  blocks?: Block[];
  html_content?: string;
  status: PartialStatus;
  /** Set on every save by the partial PUT handler — drives "pending deploy" UI. */
  date_updated?: string;
}

/** @deprecated Use PartialKind. Kept temporarily for any external consumer. */
export type PartialType = PartialKind;

// ─── Pages ───────────────────────────────────────────────────────────────

export type PageStatus = 'draft' | 'review' | 'unlisted' | 'published';

export interface Page {
  id: string;
  title: string;
  /**
   * Single URL path segment used to derive the live URL when `path` is
   * not set. Empty string `""` (or "home"/"index") is the homepage.
   * Must NOT contain slashes — for nested URLs set `path` explicitly.
   * The two-field model means slug is always a leaf id, never a route.
   */
  slug: string;
  /**
   * Explicit live URL when set, e.g. "/erbjudanden/sommar-2026".
   * Must start with "/", lowercase, segments separated by "/", no `..`,
   * no double-slash. When omitted, the URL falls back to "/" + slug (or
   * "/" for the homepage). Allowing a separate `path` is the primitive
   * for nested page URLs without abusing `slug` semantics — see
   * docs/page-path-plan.md (C6 follow-up from the autopilot.se field
   * report).
   */
  path?: string;
  parent?: string | null;
  sort_order?: number;
  template?: string;

  content_mode: ContentMode;
  blocks?: Block[];
  html_content?: string;

  seo_title?: string;
  seo_description?: string;
  og_image?: string;
  /**
   * Alt text for the OG/Twitter image. Falls back to the page's first
   * `<img alt>` when unset. Surfaced as `og:image:alt` + `twitter:image:alt`
   * meta tags — important for accessibility readouts and a small SEO signal.
   */
  seo_image_alt?: string;
  canonical_url?: string;
  noindex?: boolean;
  /**
   * `<link rel="alternate" hreflang>` targets for this page's equivalents
   * on sister sites. The shape a multi-domain, multi-language family needs:
   * each site is its own Typeroll site (one Site = one domain), so the
   * cross-links can't be derived — they're declared per page.
   *
   * The renderer adds the self-reference automatically (Google requires
   * every page in a cluster to list itself), so only list the OTHER
   * language variants here. Use `x-default` for the language selector or
   * the fallback locale.
   *
   * Entries with an invalid tag or a non-http(s) href are dropped at
   * render time rather than emitted — a malformed hreflang is worse than
   * a missing one. See `hreflang.ts`.
   */
  alternates?: HreflangAlternate[];
  /**
   * Optional override for the sitemap's `<lastmod>` value. Set to an
   * empty string `""` to suppress lastmod entirely for this page (use
   * when minor edits shouldn't bump the freshness signal). Any other
   * ISO-8601 string is used verbatim. When undefined, the sitemap falls
   * back to date_updated || date_published.
   */
  lastmod_override?: string;
  json_ld?: string;
  /** Editorial classification driving Open Graph + JSON-LD shape. Default 'page'.
   *  Use 'article' for blog posts, news, anything date-stamped. */
  kind?: 'page' | 'article';
  /**
   * Free-form Schema.org type for auto-generated JSON-LD on this page.
   * Examples: "Service", "Product", "Event", "FAQPage", "Course". The
   * renderer maps a small set of known types to a built-in shape (see
   * page-schema.ts); anything else is emitted as a minimal envelope
   * the user can extend via `json_ld`. Distinct from `kind` (which
   * controls Open Graph + the Article auto-schema).
   */
  schema_type?: string;
  /**
   * Service-specific fields used when `schema_type === 'Service'`.
   * Emitted as a nested `Offer` inside the Service JSON-LD so price /
   * availability are crawler-readable.
   */
  service?: {
    price?: number | string;
    /** ISO 4217 currency code (SEK, EUR, USD). */
    price_currency?: string;
    /** Free-text duration ("2 weeks", "PT45M") shown in the offer. */
    duration?: string;
    /** Short tagline emitted as the Service description. */
    description?: string;
    /** Optional URL to the page that fulfils the offer. */
    url?: string;
  };
  /** Free-text author name, only used when kind === 'article'. */
  author?: string;

  /**
   * Default `sizes` attribute for this page's responsive-image `<picture>`
   * output, applied by the SEO transform when an individual `<img>` doesn't
   * carry its own `sizes`. Overrides the site-wide
   * `SiteSettings.image_sizes_default`; a per-image `sizes` attribute still
   * wins over both. Use when a page's images render much narrower than the
   * generic default assumes (e.g. a container-constrained 360px hero) so the
   * browser stops over-fetching the larger variant. Example value:
   * "(max-width: 640px) 360px, 560px".
   */
  image_sizes_default?: string;

  old_wp_url?: string;
  status: PageStatus;
  ai_generated?: boolean;
  date_published?: string;
  date_updated?: string;
  /**
   * Scheduled publishing. When the publish sweep runs at/after this ISO
   * time it flips status → published (stamping date_published if unset),
   * clears the field, and enqueues one deploy for the site. Publish-state
   * like `status`: applies immediately, never part of a working copy.
   */
  publish_at?: string | null;
  /** Scheduled unpublish: sweep flips status → draft at/after this time. */
  unpublish_at?: string | null;
  /**
   * Override the site's default language for this single page. BCP-47
   * tag (`en`, `sv`, `de-CH`). Useful when one page is a translation
   * but the rest of the site is in another language. Defaults to
   * `Site.language` when unset.
   */
  language?: string;
  /**
   * Per-page custom CSS, injected into <head> as a `<style>` block AFTER the
   * site-level `SiteSettings.custom_css` (so a page can override site styling).
   * This is the right home for page-specific styling — page metadata, NOT a
   * content block. It exists so authors/agents stop stuffing a `<style>` into a
   * `core/html` content block (opaque, un-editable in the visual editor).
   * Injected raw via `set:html`, exactly like site `custom_css`; it's a
   * stylesheet, not a script vector. Same credential model as the other
   * scriptable surfaces: writable via API-key (REST/MCP) but NOT exposed to
   * the cookie-auth chat tool surface.
   */
  custom_css?: string;
}

/**
 * What was edited. Used to surface the right kind of restore action in the UI
 * (page editor vs partial editor vs collection-item editor).
 */
export type RevisionKind = 'page' | 'partial' | 'collection-item';

/**
 * A pre-edit snapshot. The full doc body lives under `doc` so restoring is a
 * straight overwrite — no diff replay needed. Revisions are per-version
 * (stored under the active branch); they don't follow the chain.
 */
export interface Revision<T = Record<string, unknown>> {
  id: string;
  kind: RevisionKind;
  created_at: string;
  created_by: string;
  note?: string;
  doc: T;
}

// ─── Working copies ──────────────────────────────────────────────────────

/** Which editor surface a working copy belongs to. */
export type WorkingCopyKind = 'page' | 'partial' | 'item';

/**
 * Server-side scratch state for in-editor edits that haven't been
 * deliberately saved yet. The editors autosave here (crash-safe), and the
 * explicit "Save" action in the Publish menu promotes the fields onto the
 * canonical doc through the normal PUT path (revision snapshot, SEO
 * transform, redirect hygiene) and deletes the copy.
 *
 * Working copies are per-version but do NOT follow the COW chain — they're
 * editor state, not content. Deploys, shared preview links, the chat AI,
 * MCP and the v1 REST API never read them; only the cookie-auth editor
 * preview overlays them.
 */
export interface WorkingCopy {
  /** Constructed key: `page--{id}`, `partial--{id}`, `item--{collection}--{id}`. */
  id: string;
  kind: WorkingCopyKind;
  /** The doc id this copy shadows (pageId / partialId / itemId). */
  target_id: string;
  /** For kind='item': the collection name. */
  collection?: string;
  /** Shallow field overrides, whitelisted per kind at the API boundary. */
  fields: Record<string, unknown>;
  updated_at: string;
  updated_by?: string;
}

export interface Redirect {
  id: string;
  from_path: string;
  to_path: string;
  status_code: 301 | 302;
  auto_generated?: boolean;
  verified?: boolean;
  last_checked?: string;
}

export interface Media {
  id: string;
  filename: string;
  cdn_url: string;
  /** Cloudflare R2 object key — needed to delete the underlying object. */
  r2_key?: string;
  alt_text?: string;
  title?: string;
  caption?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  mime_type?: string;
  uploaded_by?: string;
  created_at: string;
  /**
   * Pre-rendered srcset variants generated by the image pipeline. One entry
   * per (width, format) combo we produced at upload-time. Used to emit
   * `<img srcset>` markup without runtime image transformation. Absent when
   * the variant pipeline hasn't been run (legacy media, or non-image
   * files like PDFs).
   */
  variants?: MediaVariant[];
}

export interface MediaVariant {
  width: number;
  format: 'jpeg' | 'webp' | 'avif';
  cdn_url: string;
  size_bytes: number;
}

// ─── Migration URL inventory ─────────────────────────────────────────────

/**
 * One entry in the migration's URL inventory — every old-site URL we
 * discovered (from sitemap, REST, internal links, helper plugin, GSC). The
 * *status* (migrated / redirected / unhandled / excluded) is computed at
 * read time from the current page list + redirect rules + the excluded
 * flag below, so the inventory docs stay simple and never go stale.
 */
export interface MigrationUrl {
  id: string;
  path: string;         // relative path on the old site, e.g. /old-services
  full_url: string;     // original absolute URL
  sources: string[];    // sitemap | rest-page | rest-post | rest-{type} | internal-link | helper | gsc
  excluded?: boolean;   // user explicitly marked as "do not migrate / will 404"
  notes?: string;
  gsc_clicks?: number;
  gsc_impressions?: number;
  found_at: string;
}

// ─── Blocks ──────────────────────────────────────────────────────────────

import type { Breakpoint } from './breakpoints.js';

export interface ResponsiveOverride {
  hidden?: boolean;
  data_overrides?: Record<string, unknown>;
  class_overrides?: string;
}

export interface Block {
  id: string;
  type: string;
  data: Record<string, unknown>;

  /**
   * Optional editorial label shown in the block editor's structure tree,
   * overriding the derived content/type label. Editorial only — the renderer
   * ignores it. Set via double-click-to-rename in the tree.
   */
  name?: string;

  children?: Block[];
  slots?: Block[][];

  /**
   * Per-breakpoint data overrides. Mobile-first inheritance: the value at
   * `mobile` is the baseline; each larger breakpoint overrides upward.
   * Legacy docs may carry only `{ mobile?, tablet? }`; the resolver
   * (`resolveResponsive` in `breakpoints.ts`) handles both shapes
   * transparently.
   */
  responsive?: { [K in Breakpoint]?: ResponsiveOverride };

  /**
   * Universal visibility control — hide this block at the listed
   * breakpoints. The renderer emits `data-hidden-{bp}` attributes; a
   * single global stylesheet rule (`packages/shared/src/blocks-runtime.css`)
   * does the rest. Doesn't require BlockType opt-in.
   */
  hidden_on?: Breakpoint[];

  style_overrides?: {
    spacing_before?: string;
    spacing_after?: string;
    custom_css?: string;
    custom_class?: string;
    html_id?: string;
  };
}

export type FieldType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'image'
  | 'file'
  | 'color'
  | 'select'
  | 'boolean'
  | 'number'
  | 'url'
  | 'email'
  | 'date'
  | 'datetime'
  | 'list'
  | 'list_simple'
  // Added in the Tier 1 block library:
  | 'icon'             // icon-name picker against a curated set
  | 'array'            // repeating group; uses FieldDefinition.fields[]
  | 'object'           // nested grouping; uses FieldDefinition.fields[]
  | 'block_type_ref'   // pick a BlockType.id (for repeater item_block)
  | 'collection_ref'   // pick a Collection.name
  | 'item_ref'         // pick ONE item from ref_collection
  | 'item_ref_list'    // pick many items from ref_collection
  // Added by Forms 2.0 (form/* field blocks):
  | 'choices';         // array of {value,label}; renderer derives
                       // {name}_options_html per FieldDefinition.choices_markup

export interface FieldDefinition {
  name: string;
  type: FieldType;
  label: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: string[];
  fields?: FieldDefinition[];
  responsive?: boolean;
  min?: number;
  max?: number;
  /** For type 'choices': which control markup the renderer derives. */
  choices_markup?: 'select' | 'radio' | 'checkbox';
  /**
   * Target collection for `item_ref` / `item_ref_list` — the machine name,
   * as in `collection_ref`. The stored value is the referenced item's id (or
   * an array of ids); the renderer resolves it against the collection source,
   * which already pre-loads every published item, so a ref costs a map lookup
   * rather than a fetch.
   *
   * A ref to a deleted item resolves to nothing and the renderer skips it.
   * There is deliberately NO referential integrity enforcement: a directory
   * ingests messy data, and a hard constraint would block writes an agent
   * legitimately wants to make.
   */
  ref_collection?: string;
  /**
   * Which surfaces may write this field (collection-item fields only).
   * Omitted → `['portal', 'agent']`, exactly today's behaviour.
   *
   * - `portal` — org members in the Typeroll UI
   * - `owner`  — the listed entity itself, via a one-time edit link
   * - `agent`  — bearer API key (v1 REST / MCP) and the chat AI
   * - `app`    — the app's own server logic only; no external surface
   * - `import` — bulk seeding (registry dumps, migrations); ranks lowest, so
   *              re-running a seed can never undo later enrichment
   *
   * Owner-writability is opt-in per field ON PURPOSE: adding a
   * public-facing edit surface must never retroactively expose fields on a
   * collection that predates it. See lib/field-authority.ts.
   */
  writable_by?: Array<'portal' | 'owner' | 'agent' | 'app' | 'import'>;
  /**
   * False for fields the published site never renders — an agent's working
   * state that a portal operator still wants to see (last outreach date, a
   * confidence score). Excluded from build snapshots and the render context,
   * so it costs no build time and can't be bound in a template.
   *
   * The boundary rule this serves: Typeroll holds what the published site
   * renders, plus join keys. Everything that only informs an agent's
   * decisions belongs in the agent's own store — `rendered: false` is the
   * deliberate exception, not the default place to put such data.
   */
  rendered?: boolean;
  /**
   * Token→CSS map for responsive fields whose option values are NOT directly
   * usable as a CSS value (e.g. `icon-left` → `flex-direction: row`). Without
   * it the renderer can only override the raw `--{field}` custom property per
   * breakpoint — which a block CSS that maps the token via a
   * `[style*="--field:token"]` selector can't react to (the inline style
   * string never changes per breakpoint). With `responsive_css` the renderer
   * emits the MAPPED declarations into the per-instance @media block, so
   * per-breakpoint behaviour (icon-top on mobile, icon-left on tablet, …)
   * actually takes effect. Keys are the field's option values; values are CSS
   * declaration strings, e.g. `{ 'icon-left': '--layout-dir: row;' }`.
   * Requires `responsive: true`. See docs/responsive-blocks.md.
   */
  responsive_css?: Record<string, string>;
}

export type BlockCategory = 'layout' | 'content' | 'media' | 'custom';
export type BlockOrigin = 'core' | 'ai' | 'user' | 'third_party';

/**
 * Reserved block type id used by page templates to mark "the page's own
 * blocks render here". The renderer replaces this block with the page's
 * `blocks` tree at render time. Cannot be created as a regular BlockType.
 */
export const TEMPLATE_CONTENT_SLOT_TYPE_ID = 'template_content_slot' as const;

/**
 * Tracks where a third-party / imported block came from so the UI can show
 * "installed from package X v1.2.0" and an Update action knows which version
 * is currently in use. Only present on BlockType docs with origin =
 * 'third_party' or origin = 'user' (when imported from a .tcblocks zip).
 */
export interface BlockPackageRef {
  package_name: string;
  version: string;
  /** ISO timestamp of when the block was imported into this site. */
  imported_at: string;
}

export interface BlockType {
  id: string;
  name: string;
  label: string;
  icon?: string;
  category: BlockCategory;
  /**
   * Container kind:
   * - `false`  — leaf block, no children
   * - `true`   — generic container, renders children via `{{children}}`
   * - `'slots'` — multiple named slots via `{{slot:NAME}}`, declared by
   *               `slot_count`/`slot_labels`
   * - `'repeater'`    — loops over a list (static items[] or a collection
   *               query); each iteration renders via `item_block`
   * - `'conditional'` — renders `children` only if a condition expression
   *               evaluates truthy against the render context
   */
  container: boolean | 'slots' | 'repeater' | 'conditional';
  slot_count?: number;
  slot_labels?: string[];
  /**
   * Marks this block as suitable for use as a repeater's `item_block`.
   * Item-compatible blocks are designed without outer section/padding,
   * so they tile cleanly inside a grid/list/carousel. The block-type
   * picker filters by this flag in the repeater UI.
   */
  item_compatible?: boolean;
  /**
   * Optional alias: this block expands to another block type with
   * default overrides at render time. Used to package convenience
   * blocks (e.g. `core/gallery` → `core/repeater` with `item_block:
   * 'core/image'`, `layout: 'grid'`) so the page tree stays readable
   * and AI-friendly while the renderer reuses the repeater primitive.
   */
  expand_to?: {
    target: string;
    defaults: Record<string, unknown>;
  };
  schema: FieldDefinition[];
  /**
   * HTML template. May contain `{{field_name}}` (HTML-escaped substitution)
   * and `{{{field_name}}}` (raw substitution, for richtext fields). For
   * container blocks, `{{children}}` marks where child blocks render. For
   * slot blocks, `{{slot:NAME}}` marks each named slot's render position.
   */
  template?: string;
  /** Block-scoped CSS. Concatenated into the per-site blocks bundle at build time. */
  styles?: string;
  /**
   * Optional client-side JS. Trusted: it ships verbatim into the visitor's
   * browser. Accepted via MCP/API (caller's responsibility) and via the
   * portal UI behind an explicit consent toggle. The chat AI's tool surface
   * does NOT expose this field — the model cannot set it.
   *
   * The runtime calls `window.TyperollBlocks.register(id, init)` with the
   * block's id and an init function `(el: HTMLElement, data: BlockData) => void`.
   */
  script?: string;
  /**
   * Names of `schema` fields whose values this block type's renderer emits as
   * EXECUTABLE CODE rather than as sanitized markup — i.e. per-instance JS
   * living in `block.data`, the way `script` above is per-type JS.
   *
   * Declaring a field here puts it under the same trust ladder as `script`
   * (see lib/block-script-gate.ts): the chat AI is gated on
   * `Site.ai_scripts_enabled`, bearer keys write freely but get an audit-log
   * entry and SCRIPT_WRITE_NOTICE, portal-cookie humans are trusted.
   *
   * Why declarative: block *instance* writes (add_block/update_block) do not
   * pass through the per-type script gate, so a block type that carried code
   * in `block.data` would let the chat AI ship visitor-executed JS around the
   * gate built to stop exactly that. Naming the fields on the type means the
   * generic write path can gate them without anyone remembering to add a call
   * site — a new scriptable block inherits the gate by declaring the field.
   *
   * Ordinary markup fields do NOT belong here: block output already passes
   * through the customer-HTML sanitizer, which strips `<script>`. This is only
   * for values that bypass that pass.
   *
   * ⚠️ Deliberately NOT writable through any agent surface — it's absent from
   * the v1 block-types WRITABLE whitelist and from the chat's update_block_type
   * patch. Clearing it is how you'd ungate a field and then write JS into it
   * via update_block, so it stays code-declared. Making it writable needs the
   * same consent ceremony as `script` itself, not a whitelist line.
   */
  script_fields?: string[];
  /** @deprecated Renamed for clarity. Set `origin` going forward. Reads still honor this for legacy docs. */
  created_by?: BlockOrigin;
  /**
   * Provenance of the block type. Determines update path:
   * - `core`: shipped in code, updated via deploy
   * - `ai`: created by the chat AI on the user's behalf
   * - `user`: created by an org member in the portal UI
   * - `third_party`: installed from a package (registry or zip)
   */
  origin?: BlockOrigin;
  /** Set when this block came from a .tcblocks package or a third-party registry. */
  imported_from?: BlockPackageRef;
  /**
   * Runtime metadata for a block provisioned by an installed Extension.
   * The renderer emits these identifiers as inert data attributes; the
   * shared Extension host mounts the immutable, vendored component later.
   * No installation secret or URL credential belongs here.
   */
  extension?: {
    extension_id: string;
    installation_id: string;
    component_id: string;
    render_mode: 'bundled_component' | 'embedded_app';
  };
  shared?: boolean;
  created_at: string;
}

// ─── Page Templates ──────────────────────────────────────────────────────

export type PageTemplateStatus = 'draft' | 'published';

/**
 * A reusable layout shell for pages. Composed of the same Block tree shape as
 * a page itself, but with one or more blocks of type
 * `TEMPLATE_CONTENT_SLOT_TYPE_ID` marking where the consuming page's own
 * blocks render. Pages reference a template via `Page.template` (= this
 * doc's id). Optional `applies_to` constrains the picker to a specific
 * collection or to the global page editor.
 */
export interface PageTemplate {
  id: string;
  name: string;
  label: string;
  icon?: string;
  /**
   * Where this template can be assigned.
   * - `page`: assignable to any standalone page
   * - `collection:{name}`: only for items of the named collection
   * - `any`: shown everywhere (default)
   */
  applies_to?: 'page' | 'any' | `collection:${string}`;
  blocks: Block[];
  status: PageTemplateStatus;
  created_at: string;
  date_updated?: string;
}

// ─── Content Collections ─────────────────────────────────────────────────

export interface CollectionDef {
  id: string;
  name: string;             // machine name: blog, team, events
  label_singular: string;   // "Blog post"
  label_plural: string;     // "Blog posts"
  icon?: string;            // emoji
  fields: FieldDefinition[];
  slug_field?: string;      // which field is the URL slug (defaults to "slug")
  sort_field?: string;      // default sort field
  sort_dir?: 'asc' | 'desc';

  /**
   * URL template for items in this collection. Tokens look like
   * `{slug}`, `{date:YYYY/MM}`, `{category}` — every token resolves
   * against a field on the item. Default `/{name}/{slug}` when omitted.
   * Slashes are allowed; the renderer creates one static page per
   * published item at this path.
   *
   * Set to an empty string to opt OUT of per-item URLs (the collection
   * is then "listing-only", same as pre-routing behaviour).
   */
  route_template?: string;

  /**
   * Taxonomy pages — one static page per distinct value of a field
   * (/bransch/rormokare/, /ort/goteborg/). See taxonomy.ts; note the
   * min_items guard, since this is where record count turns into ROUTE
   * count and route count is what the build timeout measures.
   */
  facets?: import('./taxonomy.js').CollectionFacet[];
  /**
   * Combination pages to also generate, as explicit pairs of facet fields.
   * NEVER a cartesian product of all facets: two facets with 30 and 200
   * values is 6000 routes, nearly all of them one-record thin-content pages.
   */
  facet_combinations?: import('./taxonomy.js').FacetCombination[];

  /**
   * Free-form Schema.org type used to auto-emit JSON-LD on every item
   * in this collection. Examples: "BlogPosting", "PodcastEpisode",
   * "Product", "Event", "Recipe", "Course", "Article". Anything goes —
   * users with niche taxonomies (MusicAlbum, SoftwareApplication, ...)
   * can plug it in without a platform change. When unset, no
   * collection-driven schema is emitted (per-item `json_ld` still
   * works).
   *
   * The companion `schema_field_map` lets the user say "this field on
   * my item is the schema property `audioUrl`" — see below.
   */
  schema_type?: string;

  /**
   * Optional mapping from collection-item field names to Schema.org
   * property names. Default behaviour is identity (a field named
   * `title` maps to `title`/`name` depending on type). Use this when
   * the collection field name doesn't match the schema vocabulary —
   * e.g. `{ "audio_url": "contentUrl", "show_notes": "description" }`.
   * Values are copied verbatim into the JSON-LD object so they should
   * use camelCase (Schema.org's convention). Unmapped fields fall
   * through to the built-in mapping inside the schema generator.
   */
  schema_field_map?: Record<string, string>;

  /**
   * HTML template rendered for each item. `{{field}}` placeholders are
   * substituted with item field values (HTML-escaped); `{{{field}}}`
   * (triple-brace) leaves the value raw for fields that intentionally
   * carry HTML (e.g. a richtext body). When omitted, the renderer falls
   * back to a minimal default that just dumps title + body so the item
   * still has *some* URL even before the template is authored.
   *
   * The template is sanitized on save like any other customer HTML —
   * no <script>, no event handlers. Substitutions happen on the
   * pre-sanitized template, then the merged result is re-sanitized at
   * render time as defense in depth.
   *
   * Mutually exclusive with `item_template_blocks` — when both are set
   * the block tree wins.
   */
  item_template_html?: string;

  /**
   * Block-tree alternative to `item_template_html`. The renderer walks
   * this tree with the current item pushed into the render context
   * (`{{item.*}}` resolves against the item's fields). Same security
   * model as page block trees — block templates are pre-sanitized;
   * data substitutions are HTML-escaped; final output runs through
   * sanitizeBody.
   *
   * Use the `template/item_*` block family (item_title, item_body,
   * item_image …) as bindings — they read from context.item without
   * the author having to type `{{item.title}}` by hand.
   *
   * When this is set, it takes precedence over `item_template_html`.
   * Set to `[]` (empty array) to explicitly mark the collection as
   * block-mode without authoring blocks yet — same effect as omitting
   * both fields (renderer falls back to a minimal default).
   */
  item_template_blocks?: Block[];

  created_at: string;
}

export interface CollectionItem {
  id: string;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  /** Scheduled publishing — same sweep semantics as Page.publish_at. */
  publish_at?: string | null;
  unpublish_at?: string | null;
  // Dynamic fields per the schema
  [key: string]: unknown;
}

// ─── Forms ───────────────────────────────────────────────────────────────

export interface FormField {
  name: string;
  type: FieldType | string;
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  default?: unknown;
  /** Regex (anchored automatically) the value must match. */
  pattern?: string;
  /** Numeric bounds for number/slider fields; char bounds for text. */
  min?: number;
  max?: number;
  /** Per-error-code message overrides (code → customer-facing text). */
  error_messages?: Record<string, string>;
}

export interface FormAction {
  /** Stable id for operationally idempotent actions such as webhooks. */
  id?: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * The `config` shape for a FormAction of `type: 'email'`. Sent after a
 * submission completes, using the site's configured EmailConnector (see
 * SiteIntegrations). `to`/`subject`/`body` may interpolate submission field
 * values: `{{field_name}}` (HTML-escaped) or `{{{field_name}}}` (raw). The
 * recipient `to` is templated too — e.g. `{{email}}` for an autoresponder.
 *
 * Email actions are ADMIN-ONLY: they are never writable through the chat AI
 * or MCP surfaces (a recipient address would otherwise be a prompt-injection
 * exfiltration vector). Only the cookie-auth admin form routes persist them.
 */
export interface EmailActionConfig {
  /** Recipient(s). Templated, then validated as email(s). */
  to: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  /** Templated subject line. */
  subject: string;
  /** Templated body. HTML when format !== 'text'. */
  body: string;
  /** Append an auto-rendered table/list of every submitted value. */
  include_all?: boolean;
  /** 'html' (default) or 'text'. */
  format?: 'html' | 'text';
}

/**
 * One step in a Forms 2.0 funnel. The step body is a Block[] tree —
 * `form/*` field blocks are the inputs; any other block (prose, image,
 * grid, …) is content between them. Field DEFINITIONS in steps-mode are
 * derived from the form/* blocks (single source of truth) — Form.fields
 * stays authoritative only for legacy single-step forms.
 * See docs/plans/forms-funnels.md.
 */
export interface FormStep {
  id: string;
  title?: string;
  blocks?: Block[];
  /**
   * 'static' (default) — prerendered into the page at build time, swapped
   * locally by the forms runtime. 'dynamic' — rendered by the forms
   * service at submit time (app-computed content).
   */
  render?: 'static' | 'dynamic';
  /** Next step id. Default: next in list. Last step with no next → done. */
  next?: string;
  /** v2 app hooks — reserved, never executed in v1. */
  actions?: FormStepAction[];
}

/** Reserved v2 shape: apps contribute handlers keyed by `type`. */
export interface FormStepAction {
  hook: 'validate' | 'after_submit' | 'before_next';
  type: string;
  config: Record<string, unknown>;
}

export interface Form {
  id: string;
  name: string;
  actions: FormAction[];
  submit_text?: string;
  success_message?: string;
  created_at: string;
  /** Forms 2.0: 'form' (default). Apps register their own kinds (quiz, …). */
  kind?: string;
  /**
   * Send this form somewhere other than the submissions collector.
   *
   * The forms module stays app-agnostic on purpose: it understands the two
   * generic BEHAVIOURS below and nothing about which app wants them. `app` is
   * opaque here — the build asks the apps registry to resolve the endpoint,
   * so a second app needing a prefilled, session-bound form adds a registry
   * entry and touches no form code at all.
   */
  /**
   * Where this form's initial values come from, in order — later sources win.
   * Same declared-list shape as `actions`, resolved through its own registry
   * (lib/forms/prefill.ts) because prefill returns data and runs before the
   * form is shown, where an action is a side effect that runs after.
   */
  prefill?: FormAction[];
  target?: {
    /** App owning the endpoint. Resolved via the apps registry at build time. */
    app?: string;
    /**
     * Which of the app's endpoints, when it owns more than one. Opaque to the
     * forms module; the app's own resolver interprets it.
     */
    form?: string;
    /**
     * Fetch current values from the endpoint and prefill the fields before
     * showing the form. Response shape: `{ fields: [{ name, value }] }`.
     */
    hydrate?: boolean;
    /**
     * Query parameter carrying a one-time token. The runtime exchanges it for
     * a session token on first load, stores it for the tab, strips it from
     * the URL, and sends it as `Authorization: Bearer` afterwards.
     */
    session_param?: string;
  };
  /** Reserved: the app package this form belongs to. */
  package?: string;
  /**
   * THE form model: an ordered list of steps, each a Block[] tree of
   * form/* field blocks (+ content blocks between fields). A simple form
   * is one static step. There is no separate field list — the write APIs
   * accept a flat `fields` array as authoring sugar and convert it to a
   * single step server-side (fieldsToSteps); wire-level validation derives
   * its FormField definitions from the step blocks (collectStepFields).
   */
  steps?: FormStep[];
  /** Form-scoped CSS, sanitized + scoped to the form root (BlockType.styles model). */
  styles?: string;
  /** Days a partial submission survives before cleanup. Default 30. */
  partial_ttl_days?: number;
}

export interface FormSubmission {
  id: string;
  form_id: string;
  data: Record<string, unknown>;
  created_at: string;
  /** Absent → 'complete' (legacy docs predate partial saves). */
  status?: 'partial' | 'complete';
  /** Last completed step id (steps-mode only). */
  step?: string;
  updated_at?: string;
  /** Partials only: ISO timestamp after which cleanup may delete the doc. */
  expires_at?: string;
}

/** Operational log for one generic form-webhook event. Payload values stay in
 * the canonical submission document; this record contains delivery metadata. */
export interface FormWebhookDelivery {
  id: string;
  event_id: string;
  form_id: string;
  submission_id: string;
  webhook_id: string;
  url: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  created_at: string;
  updated_at: string;
  delivered_at?: string;
  response_status?: number;
  last_error?: string;
}

// ─── Integrations (site-level, shared across all Typeroll apps) ────────────

/**
 * A per-site email transport. Forms is the first consumer; future apps reuse
 * the same connector. Stored in a dedicated, UNVERSIONED per-site doc
 * (paths.integrations) — NOT in SiteSettings, which is copy-on-write versioned
 * and surfaced into the render context as `{{site.*}}` (secrets must not leak
 * into snapshots or customer templates).
 *
 * `type` is a provider id (postmark, smtp, and — later — resend, ses, …). The
 * provider-specific settings live in `config`, keyed by the field keys the
 * provider declares (see portal lib/email/providers). Secret values are stored
 * under a `${key}_enc` key holding AES-256-GCM ciphertext only (see portal
 * lib/secret-crypto.ts) and are never returned in plaintext — the admin route
 * masks them. Keeping config provider-agnostic is what lets a new provider be
 * added without touching the data model, dispatch, encryption, or UI.
 */
export interface EmailConnector {
  type: string;
  /** Default From, e.g. "Acme <hello@acme.com>". */
  from: string;
  reply_to?: string;
  /** Provider-specific config; secret fields stored as `${key}_enc`. */
  config: Record<string, unknown>;
}

/**
 * A single issued edit link. See lib/edit-grants.ts — the token is HMAC'd
 * over this doc's id, so possession of a link is worthless once the doc is
 * marked used or revoked.
 */
export interface EditGrant {
  id: string;
  collection: string;
  item_id: string;
  /** Address the link was mailed to; the item's own contact field at issue time. */
  email: string;
  issued_at: string;
  expires_at: string;
  /** Set on first redemption. A grant is single-use. */
  used_at?: string | null;
  revoked_at?: string | null;
}

export interface SiteIntegrations {
  email?: EmailConnector;
  updated_at?: string;
}

// ─── Typeroll apps (optional, per-site opt-in features) ────────────────────

/**
 * The catalog of optional "Typeroll apps" — features a site owner turns on
 * per site, OFF by default (analytics is the first; visitor language
 * auto-negotiation is a planned second). The registry that describes each
 * app (label, config field schema) lives in portal code
 * (lib/apps/registry.ts), mirroring the workflow registry; this union just
 * names the members so shared code (paths, materialize, renderer) can key
 * off them.
 */
export type AppId = 'analytics' | 'integrations' | 'directory' | 'funnel_attribution';

export interface FunnelAttributionParameter {
  from: string;
  to?: string;
  fallback?: string;
  max_length?: number;
}

export interface FunnelAttributionTarget {
  type: 'link';
  protocol?: 'https:';
  host: string;
  path: string;
  click_event?: string;
  destination?: string;
}

export interface FunnelAttributionStorage {
  enabled: boolean;
  ttl_days?: number;
  touch?: 'first_touch' | 'last_touch' | 'both';
  read_touch?: 'first_touch' | 'last_touch';
  consent?: 'optional';
  cookie_domain?: string;
}

export interface FunnelAttributionRule {
  id: string;
  page_paths?: string[];
  source?: 'current_url' | 'current_or_stored';
  parameters: FunnelAttributionParameter[];
  targets: FunnelAttributionTarget[];
  precedence?: 'source_over_target' | 'target_over_source';
  storage?: FunnelAttributionStorage;
}

export interface FunnelAttributionConfig {
  funnels: FunnelAttributionRule[];
  /** Explicit admin override for forwarding fields such as email or phone. */
  allow_personal_data?: boolean;
  /** Explicit acknowledgement that fallback values create synthetic attribution. */
  allow_synthetic_fallbacks?: boolean;
}

/** A consented, first-party conversion event recorded by the Analytics app. */
export interface AnalyticsEvent {
  id: string;
  name: string;
  funnel_id: string;
  destination: string;
  path: string;
  attribution: Record<string, string>;
  created_at: string;
  /** Retention marker for datastore TTL policies and cleanup jobs. */
  expires_at: string;
}

/**
 * Per-site state for one app. Mirrors the EmailConnector convention:
 * provider-agnostic `config`, secret values stored under `${key}_enc` as
 * AES-256-GCM ciphertext. Only the app's declared PUBLIC keys are ever
 * written into a build snapshot (see materializeFixtures); secrets and
 * server-only config never reach the customer site.
 */
export interface AppState {
  enabled: boolean;
  config: Record<string, unknown>;
  enabled_at?: string;
}

/**
 * The per-site, UNVERSIONED apps doc (paths.apps) — a sibling of
 * SiteIntegrations, deliberately NOT SiteSettings (which is copy-on-write
 * versioned and surfaced to templates as `{{site.*}}`). Admin-only,
 * off the AI/MCP surface. The build reads a filtered PUBLIC projection of
 * this (materialize writes only enabled apps' public config).
 */
// NB: `Partial` is a local doc interface in this file (global blocks), which
// shadows TS's built-in `Partial<T>` — so spell the optional map explicitly.
export type AppStateMap = { [K in AppId]?: AppState };

export interface SiteApps {
  apps?: AppStateMap;
  updated_at?: string;
}

// ─── Chat ────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

export interface ChatAttachment {
  cdn_url: string;
  /** Original upload filename. */
  filename?: string;
  /** Convenience alias for filename used by older code paths. */
  mime_type?: string;
  /** Legacy: mime type. Prefer mime_type. */
  type?: string;
  alt_text?: string;
}

export interface ChatAction {
  type: string;
  description: string;
  target?: string;
  /** When the action targets a page, the absolute preview URL — lets the
   *  chat surface a "Preview" button alongside "Edit page". */
  preview_url?: string;
}

/**
 * One tool invocation in the chat loop. Inputs and results are stored
 * truncated — enough to understand intent and replay reasoning, not enough
 * to bloat the doc with full HTML payloads.
 */
export interface ChatToolCall {
  name: string;
  input_preview: string;
  ok: boolean;
  result_preview: string;
  /** Set when the tool threw. */
  error?: string;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
  actions_taken?: ChatAction[];
  tool_calls?: ChatToolCall[];
  /** Wall-clock ms the assistant spent on the turn. Helps spot slow paths. */
  duration_ms?: number;
  /** Number of tool-loop iterations consumed (1 = single shot, MAX = hit the cap). */
  iterations?: number;
  created_at: string;
}

// ─── Deploys ─────────────────────────────────────────────────────────────

export type DeployStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type DeployEnvironment = 'staging' | 'production';

/**
 * What one site build cost the platform to run.
 *
 * A deploy occupies a Cloud Run instance for its whole duration (the build
 * runs synchronously inside the deploy-worker request), so the marginal cost
 * of a build is wall-clock time × the resources allocated to that instance.
 * That's the model here: duration × (vCPU rate + memory rate), plus the
 * per-request fee.
 *
 * ALWAYS AN ESTIMATE. This is computed from a rate card, not read back from
 * a cloud billing API, so it won't match an invoice to the cent — free-tier
 * allowances, committed-use discounts, sustained-use and per-region pricing
 * all land outside this number. It's here to compare builds against each
 * other and to see the shape of the spend, not to reconcile a bill.
 *
 * `rates` is snapshotted onto every row on purpose: when the rate card
 * changes, historical builds keep the numbers they were costed with instead
 * of silently re-pricing themselves.
 */
export interface DeployCost {
  /** ISO-4217-ish currency label for `total` and the component costs. */
  currency: string;
  /** cpu + memory + request, in `currency`. */
  total: number;
  cpu: number;
  memory: number;
  request: number;
  /** Wall-clock seconds the build held the instance. */
  duration_s: number;
  /** Resources the instance had allocated while it ran. */
  vcpu: number;
  memory_gib: number;
  /** Rate card used for THIS row. See the note above on why it's stored. */
  rates: {
    cpu_per_vcpu_second: number;
    memory_per_gib_second: number;
    per_request: number;
  };
  /** Seconds spent per runner phase — where the money actually went. */
  phases?: Record<string, number>;
  /** Size of the generated site. Drives upload time, not compute. */
  output_bytes?: number;
  output_files?: number;
  /** Always true. Reserved so a future billing-API-backed row can say false. */
  estimated: boolean;
}

export interface DeployJob {
  id: string;
  version_id: string;
  environment: DeployEnvironment;
  status: DeployStatus;
  /** Free-text phase the runner is in — shown in the UI while running. */
  phase?: string;
  /** Resulting public URL on success. */
  deploy_url?: string;
  /** Final error message on failure. */
  error?: string;
  started_at: string;
  finished_at?: string;
  triggered_by?: string;
  /** Estimated platform cost of running this build. Written when the job
   *  reaches a terminal state — failed builds cost money too, so they get
   *  a cost row as well. Absent on jobs that ran before cost accounting. */
  cost?: DeployCost;
}

// ─── Workflows ───────────────────────────────────────────────────────────

export type WorkflowType =
  | 'migration'
  | 'site_planning'
  | 'seo_audit'
  | 'content_improvement'
  | 'link_check'
  | 'performance_audit'
  | 'content_generation'
  | 'schema_markup'
  | 'url_parity'
  | 'rebuild_deploy';

export type WorkflowStatus = 'pending' | 'running' | 'paused_for_review' | 'completed' | 'failed';

export interface Workflow {
  id: string;
  site_id: string;
  type: WorkflowType;
  status: WorkflowStatus;
  config: Record<string, unknown>;
  results?: Record<string, unknown>;
  current_step?: string;
  progress?: { total: number; completed: number; review: number; error: number };
  started_at?: string;
  completed_at?: string;
  triggered_by: 'manual' | 'schedule' | 'webhook' | 'chat';
  created_by: string;
}

// ─── API keys (public REST API) ─────────────────────────────────────────

/**
 * A site-scoped API key used by external clients (agencies running Claude
 * Code with the MCP server, custom scripts, Zapier-style integrations).
 *
 * Stored under organizations/{orgId}/sites/{siteId}/api_keys/{id} where id =
 * the key's prefix (8 chars). The secret is never persisted in plaintext —
 * only its sha256 hash. Lookup on every request is one direct doc.get() on
 * the prefix, then a timing-safe hash comparison.
 *
 * Distinct from Organization.api_keys, which is a map of third-party service
 * credentials (Anthropic, DataForSEO, etc.) that the platform uses on the
 * org's behalf — those are inbound credentials. SiteApiKeys are outbound:
 * tokens we mint for external clients to call us.
 */
export interface SiteApiKey {
  id: string;             // = key prefix, 8 chars (e.g. "8fJ3kL2m")
  name: string;           // human label set by the user at creation
  key_hash: string;       // sha256(secret), hex
  created_at: string;
  created_by: string;     // email of the user who created the key
  last_used_at?: string;
  last_used_ip?: string;
  revoked_at?: string;
  scopes?: string[];      // future-proofing; default ["full"]
}

// ─── Cross-org site sharing ──────────────────────────────────────────────

/**
 * Permission levels a site can be shared with. Ownership is implicit `admin`
 * (the owning org doesn't get a SiteShare row); these levels only apply to
 * other orgs the site has been granted to.
 *
 * - `read`  — list site, view pages, view collections; no mutations
 * - `write` — `read` + edit pages, manage collections, manage media. Cannot
 *             change site settings or share to others.
 * - `admin` — full access. Today this is owner-only (re-sharing by non-owners
 *             is intentionally disabled in v1).
 */
export type SharePermission = 'read' | 'write' | 'admin';

/**
 * One grant of access to a single site, from the owning org to another org.
 * Stored canonically under the owning site (so the owner's UI can list its
 * own grants without a cross-org scan) AND in a flat platform index under
 * `org_share_index/{shared_with_org_id}/shares/{shareId}` so the recipient
 * org can list shared-in sites in a single listDocs call.
 *
 * The two writes are not atomic across paths; readers always check the
 * canonical record after the index lookup so a half-written share fails
 * closed.
 */
export interface SiteShare {
  id: string;
  site_id: string;
  owner_org_id: string;
  shared_with_org_id: string;
  permission: SharePermission;
  created_at: number;
  created_by: string;
  revoked_at?: number | null;
  /** Optional human-readable note ("Acme Corp client review"). */
  label?: string;
}

// ─── Path Helpers ────────────────────────────────────────────────────────

/**
 * All path helpers. Per-site resources (media, forms, submissions) sit directly
 * under the site. Per-version resources (pages, partials, settings, redirects,
 * collections, chat) sit under sites/{siteId}/versions/{versionId}/ — every
 * versioned helper takes an optional versionId that defaults to 'main'.
 */
export const paths = {
  org: (orgId: string) => `organizations/${orgId}`,
  members: (orgId: string) => `organizations/${orgId}/members`,
  sites: (orgId: string) => `organizations/${orgId}/sites`,
  site: (orgId: string, siteId: string) => `organizations/${orgId}/sites/${siteId}`,

  // ─── Versions ─────────────────────────────────────────────────────────
  versions: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/versions`,
  version: (orgId: string, siteId: string, versionId: string) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}`,

  // ─── Per-version content (defaults to main) ───────────────────────────
  settings: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/settings/default`,
  partials: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/partials`,
  partial: (orgId: string, siteId: string, partialId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/partials/${partialId}`,
  pages: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/pages`,
  page: (orgId: string, siteId: string, pageId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/pages/${pageId}`,
  revisions: (orgId: string, siteId: string, pageId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/pages/${pageId}/revisions`,
  partialRevisions: (orgId: string, siteId: string, partialId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/partials/${partialId}/revisions`,
  itemRevisions: (orgId: string, siteId: string, name: string, itemId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/collections/${name}/items/${itemId}/revisions`,
  redirects: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/redirects`,
  chat: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/chat_messages`,
  blockTypes: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/block_types`,
  blockType: (orgId: string, siteId: string, blockTypeId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/block_types/${blockTypeId}`,
  pageTemplates: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/page_templates`,
  pageTemplate: (orgId: string, siteId: string, templateId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/page_templates/${templateId}`,
  collections: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/collections`,
  collection: (orgId: string, siteId: string, name: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/collections/${name}`,
  collectionItems: (orgId: string, siteId: string, name: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/collections/${name}/items`,
  collectionItem: (orgId: string, siteId: string, name: string, itemId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/collections/${name}/items/${itemId}`,
  // Editor working copies (autosaved unsaved edits). Per-version, no chain
  // fallback — see the WorkingCopy interface. Key format: `page--{id}`,
  // `partial--{id}`, `item--{collection}--{id}`.
  workingCopies: (orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/working_copies`,
  workingCopy: (orgId: string, siteId: string, key: string, versionId: string = MAIN_VERSION_ID) =>
    `organizations/${orgId}/sites/${siteId}/versions/${versionId}/working_copies/${key}`,

  // ─── Per-site (shared across versions) ─────────────────────────────────
  media: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/media`,
  /**
   * One-time edit grants — per-link records for the self-service editing
   * surface. Stored rather than stateless (unlike invite tokens) because an
   * edit link is mailed to an address taken from a registry, and mail gets
   * forwarded: a stored grant buys revocation, audit, and "already used".
   */
  editGrants: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/edit_grants`,
  editGrant: (orgId: string, siteId: string, grantId: string) =>
    `organizations/${orgId}/sites/${siteId}/edit_grants/${grantId}`,

  forms: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/forms`,
  submissions: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/submissions`,
  formWebhookDeliveries: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/form_webhook_deliveries`,
  // Site-level integration config (email connectors, …) shared across all
  // Typeroll apps and across versions. Single doc; secrets stored encrypted.
  integrations: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/integrations/default`,
  // Optional per-site apps (analytics, …) opt-in state + config. Single
  // unversioned doc; secrets encrypted; admin-only, off the AI surface.
  // Materialize writes a PUBLIC projection into build snapshots.
  apps: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/apps/default`,
  extensionInstallations: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations`,
  extensionInstallation: (orgId: string, siteId: string, installationId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations/${installationId}`,
  extensionCredentials: (orgId: string, siteId: string, installationId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations/${installationId}/credentials`,
  extensionCredential: (orgId: string, siteId: string, installationId: string, credentialId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations/${installationId}/credentials/${credentialId}`,
  extensionLaunchGrants: (orgId: string, siteId: string, installationId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations/${installationId}/launch_grants`,
  extensionLaunchGrant: (orgId: string, siteId: string, installationId: string, grantId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_installations/${installationId}/launch_grants/${grantId}`,
  extensionAudit: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_audit`,
  extensionEventDeliveries: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_event_deliveries`,
  extensionRuntimeSnapshot: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/extension_runtime/default`,
  analyticsEvents: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/analytics_events`,

  // Cross-org site shares. Canonical record lives under the owning site so
  // the owner's UI can list its grants in one call. See sharesWithOrg below
  // for the cross-org index used by recipients.
  shares: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/shares`,
  share: (orgId: string, siteId: string, shareId: string) =>
    `organizations/${orgId}/sites/${siteId}/shares/${shareId}`,

  // Public-API keys for this site (metadata: name, created_by, last_used_at,
  // revoked_at, full key_hash). The doc id is the key prefix so the UI's
  // site-scoped listing is a directListDocs. Used by the legacy
  // site-scoped API key class.
  apiKeys: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/api_keys`,
  apiKey: (orgId: string, siteId: string, prefix: string) =>
    `organizations/${orgId}/sites/${siteId}/api_keys/${prefix}`,
  // Org-scoped API keys — used by hosted-MCP connectors that span every
  // site in the org (and shared-in sites). Distinct path from site-scoped
  // keys so listings on either page stay clean.
  orgApiKeys: (orgId: string) =>
    `organizations/${orgId}/api_keys`,
  orgApiKey: (orgId: string, prefix: string) =>
    `organizations/${orgId}/api_keys/${prefix}`,
  // Write-audit trail for the public API. Reads are not logged.
  apiAudit: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/api_audit`,

  // ─── Per-org ──────────────────────────────────────────────────────────
  workflows: (orgId: string) => `organizations/${orgId}/workflows`,
  extensions: (orgId: string) => `organizations/${orgId}/extensions`,
  extension: (orgId: string, extensionId: string) =>
    `organizations/${orgId}/extensions/${extensionId}`,
  extensionVersions: (orgId: string, extensionId: string) =>
    `organizations/${orgId}/extensions/${extensionId}/versions`,
  extensionVersion: (orgId: string, extensionId: string, version: string) =>
    `organizations/${orgId}/extensions/${extensionId}/versions/${version}`,
  trustedExtensionIssuers: (orgId: string, extensionId: string) =>
    `organizations/${orgId}/extensions/${extensionId}/trusted_issuers`,
  trustedExtensionIssuer: (orgId: string, extensionId: string, issuerId: string) =>
    `organizations/${orgId}/extensions/${extensionId}/trusted_issuers/${issuerId}`,

  // Deploy jobs — per-site so each site's history is its own and we can list
  // them without scanning the whole org. id is auto-generated.
  deploys: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/deploys`,
  deploy: (orgId: string, siteId: string, deployId: string) =>
    `organizations/${orgId}/sites/${siteId}/deploys/${deployId}`,

  // Migration URLs follow the workflow they belong to (which itself stores a
  // target version_id), so they live per-site for now.
  migrationUrls: (orgId: string, siteId: string) =>
    `organizations/${orgId}/sites/${siteId}/migration_urls`,
  migrationUrl: (orgId: string, siteId: string, urlId: string) =>
    `organizations/${orgId}/sites/${siteId}/migration_urls/${urlId}`,

  // ─── Root-level indexes ───────────────────────────────────────────────
  // Reverse lookup so the public-API auth handler can resolve a presented
  // bearer token to its owning org+site without a scan. Doc id is the key
  // prefix; the doc carries { orgId, siteId, key_hash, revoked_at? }.
  // This is intentionally root-scoped (one of the few collections outside
  // organizations/) — auth doesn't know the orgId yet at lookup time.
  apiKeyLookup: () => `api_key_lookup`,
  apiKeyLookupEntry: (prefix: string) => `api_key_lookup/${prefix}`,

  // One-shot consumption record for MCP OAuth authorization codes. Written
  // by /api/mcp/oauth/token when an auth code is exchanged; a second
  // exchange of the same code finds the doc and is rejected as a replay.
  // Doc id is the code's JWT `jti`; body carries `exp` so a future TTL
  // sweep can prune. Multi-tenant safe (root collection, no org leakage —
  // the jti is just a random 8-byte hex).
  mcpConsumedCode: (jti: string) => `mcp_consumed_codes/${jti}`,

  // Hosted catalog. Self-hosted instances read only this local collection;
  // they never contact Typeroll's hosted control plane implicitly.
  extensionCatalog: () => `extension_catalog`,
  extensionCatalogEntry: (extensionId: string) => `extension_catalog/${extensionId}`,

  // Reverse index for cross-org site sharing — "give me every site shared
  // with org X". Doc id matches the canonical SiteShare doc id so writes
  // can mirror across both paths without name juggling. The body duplicates
  // the SiteShare fields; readers always re-fetch the canonical record
  // before granting access so a stale or half-written index entry can't
  // leak permission.
  sharesWithOrg: (orgId: string) =>
    `org_share_index/${orgId}/shares`,
  sharesWithOrgEntry: (orgId: string, shareId: string) =>
    `org_share_index/${orgId}/shares/${shareId}`,
};
