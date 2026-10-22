// Script audit for the migration launch report.
//
// A migrated site must not carry the source platform's runtime. WordPress
// plugins and themes inject their own JavaScript (jQuery, sliders, form and
// cookie plugins, page builders, emoji, AJAX endpoints), and copying it over
// ships dead or broken code that loads from, or posts to, a site that is about
// to be switched off. What the source did is rebuilt with native blocks and
// settings, or reported as a platform gap.
//
// Analytics and advertising tags are the exception that IS carried over, but
// only as an Integrations app ID (reviewed platform snippet) or, for a tag
// the catalog does not cover, in `cookie_consent.scripts_optional`. Either way
// it waits for the visitor's consent; a tracker pasted anywhere else fires
// before the visitor has chosen.
//
// Only script contexts are inspected (<script> elements and a site block
// type's `script`), so copied markup that merely mentions a plugin class is
// not a finding.

import { INTEGRATION_PROVIDERS, integrationConfigKey } from '@typeroll/shared';
import type { SiteApps, SiteSettings } from '@typeroll/shared';

export type ScriptFindingId = 'source_runtime_script' | 'tracking_outside_consent' | 'tracking_without_consent_banner';

export interface ScriptFinding {
  id: ScriptFindingId;
  /** Where it was found, e.g. `settings.scripts_head`, `page:/om-oss/`, `block_type:slider.script`. */
  location: string;
  /** What matched, e.g. `/wp-content/plugins/`, `fbq(`, or the integration that needs the banner. */
  match: string;
}

export interface ScriptAuditSource {
  location: string;
  /** Raw text that may contain <script> elements. */
  html?: string;
  /** A script body that runs as-is (a site block type's `script`). */
  script?: string;
}

/** The source platform's runtime: never part of a migrated site. */
const SOURCE_RUNTIME: Array<[RegExp, string]> = [
  [/\/wp-content\/(?:plugins|themes)\//i, 'WordPress plugin or theme script'],
  [/\/wp-includes\//i, '/wp-includes/'],
  [/admin-ajax\.php|\bajaxurl\b|wpApiSettings|\bwp\.i18n\b/i, 'WordPress AJAX/REST runtime'],
  [/\bjquery(?:[.-][\w.-]*)?\.js\b|\bjQuery\s*[.(]/i, 'jQuery'],
  [/wp-emoji|_wpemojiSettings/i, 'WordPress emoji'],
  [/elementorFrontend|elementor\/|breakdance|et_pb_|\bdivi\b|vc_js|wpbakery/i, 'page builder runtime'],
  [/\bwpcf7\b|gform|wpforms|ninja-forms|fluentform/i, 'form plugin'],
  [/woocommerce|wc-add-to-cart|wc_cart/i, 'WooCommerce'],
  [/cookieyes|complianz|cookiebot|cookie-law-info|borlabs|moove_gdpr|iubenda/i, 'cookie plugin (use the site cookie banner)'],
];

/** Tracking tags: allowed only behind consent. */
const TRACKERS: Array<[RegExp, string]> = [
  [/googletagmanager\.com|google-analytics\.com|\bgtag\s*\(/i, 'Google Analytics / Tag Manager'],
  [/connect\.facebook\.net|\bfbq\s*\(/i, 'Meta Pixel'],
  [/snap\.licdn\.com|_linkedin_partner_id/i, 'LinkedIn Insight'],
  [/analytics\.tiktok\.com|\bttq\.load/i, 'TikTok Pixel'],
  [/static\.hotjar\.com|\bhj\s*\(\s*['"]/i, 'Hotjar'],
  [/clarity\.ms/i, 'Microsoft Clarity'],
  [/s\.pinimg\.com\/ct|\bpintrk\s*\(/i, 'Pinterest Tag'],
  [/sc-static\.net\/scevent|\bsnaptr\s*\(/i, 'Snap Pixel'],
  [/redditstatic\.com\/ads|\brdt\s*\(\s*['"]init/i, 'Reddit Pixel'],
  [/static\.ads-twitter\.com|\btwq\s*\(/i, 'X Pixel'],
  [/bat\.bing\.com|\buetq\b/i, 'Microsoft Advertising UET'],
  [/js\.hs-scripts\.com|js\.hs-analytics\.net/i, 'HubSpot'],
  [/plausible\.io\/js|cdn\.usefathom\.com|\b_paq\.push/i, 'Plausible / Fathom / Matomo'],
];

const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/?>/gi;

function scriptContexts(source: ScriptAuditSource): string[] {
  const out = source.script?.trim() ? [source.script] : [];
  if (source.html) out.push(...(source.html.match(SCRIPT_ELEMENT) ?? []));
  return out;
}

function firstMatch(text: string, rules: Array<[RegExp, string]>): string | null {
  for (const [pattern, label] of rules) if (pattern.test(text)) return label;
  return null;
}

/**
 * Inspect every script-capable surface of a migrated site.
 *
 * `consentGated` sources are the one place a tracker may sit outside the
 * Integrations app: `cookie_consent.scripts_optional`, held until consent.
 */
export function auditMigrationScripts(input: {
  settings: Partial<SiteSettings> | null | undefined;
  apps: SiteApps | null | undefined;
  sources: ScriptAuditSource[];
}): ScriptFinding[] {
  const findings: ScriptFinding[] = [];
  const settings: Partial<SiteSettings> = input.settings ?? {};
  const banner = settings.cookie_consent?.enabled === true;
  const settingsSources: Array<ScriptAuditSource & { consentGated?: boolean }> = [
    { location: 'settings.scripts_head', html: settings.scripts_head },
    { location: 'settings.scripts_body_end', html: settings.scripts_body_end },
    { location: 'settings.cookie_consent.scripts_necessary', html: settings.cookie_consent?.scripts_necessary },
    { location: 'settings.cookie_consent.scripts_optional', html: settings.cookie_consent?.scripts_optional, consentGated: banner },
  ];
  for (const source of [...settingsSources, ...input.sources]) {
    const seen = new Set<string>();
    for (const context of scriptContexts(source)) {
      const runtime = firstMatch(context, SOURCE_RUNTIME);
      if (runtime && !seen.has(`r:${runtime}`)) {
        seen.add(`r:${runtime}`);
        findings.push({ id: 'source_runtime_script', location: source.location, match: runtime });
      }
      const tracker = firstMatch(context, TRACKERS);
      if (tracker && !('consentGated' in source && source.consentGated) && !seen.has(`t:${tracker}`)) {
        seen.add(`t:${tracker}`);
        findings.push({ id: 'tracking_outside_consent', location: source.location, match: tracker });
      }
    }
  }

  const integrations = input.apps?.apps?.integrations;
  if (integrations?.enabled && !banner) {
    for (const provider of INTEGRATION_PROVIDERS) {
      // Analytics and advertising need consent; a functional client key (address
      // suggestions) or a support chat is not tracking.
      if (provider.consent_category !== 'analytics' && provider.consent_category !== 'marketing') continue;
      const configured = provider.fields.every(field => {
        const value = integrations.config?.[integrationConfigKey(provider.id, field.key)];
        return typeof value === 'string' && field.pattern.test(value.trim());
      });
      if (configured) findings.push({ id: 'tracking_without_consent_banner', location: 'apps.integrations', match: provider.name });
    }
  }
  return findings;
}

const ISSUE_TEXT: Record<ScriptFindingId, string> = {
  source_runtime_script:
    'Scripts from the source platform were copied (plugins, theme, jQuery, page builder or cookie plugin). Remove them and rebuild what they did with native blocks and settings, or report a platform gap.',
  tracking_outside_consent:
    'Tracking code runs without consent. Move it to the Integrations app (by ID) with the cookie banner enabled, or, when the catalog has no provider, into cookie_consent.scripts_optional.',
  tracking_without_consent_banner:
    'Analytics or advertising integrations are enabled while the cookie banner is off, so they fire before the visitor chooses. Enable cookie_consent.',
};

/** One launch-report issue per finding kind, naming where it was found. */
export function scriptAuditIssues(findings: ScriptFinding[]): Array<{ id: string; detail: string }> {
  const issues: Array<{ id: string; detail: string }> = [];
  for (const id of Object.keys(ISSUE_TEXT) as ScriptFindingId[]) {
    const matching = findings.filter(finding => finding.id === id);
    if (!matching.length) continue;
    const where = matching.slice(0, 5).map(finding => `${finding.location} (${finding.match})`).join(', ');
    const more = matching.length > 5 ? ` and ${matching.length - 5} more` : '';
    issues.push({ id, detail: `${ISSUE_TEXT[id]} Found in ${where}${more}.` });
  }
  return issues;
}
