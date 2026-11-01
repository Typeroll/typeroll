// Read a Cloudflare zone's AI crawler settings through the organization's
// existing Cloudflare connection. Read-only: Typeroll never changes a zone's
// security settings, and it never asks for a permission just for this check.
// Without `Bot Management Read`, the caller reports how to check the dashboard.

import { findZone } from './domain-provider';
import type { ZoneSource } from './host-checks';

export interface ZoneAiPolicy {
  zone: string;
  host: string;
  /** Cloudflare's per-category AI crawler policies (`disabled` means allowed). */
  ai_search: string | null;
  ai_training: string | null;
  ai_user: string | null;
  /** Legacy "Block AI bots" switch: `block`, `only_on_ad_pages` or `disabled`. */
  ai_bots_protection: string | null;
  /** Cloudflare prepends its own directives to the site's robots.txt. */
  managed_robots_txt: boolean;
}

export type ZoneAiPolicyRead =
  | { status: 'read'; policy: ZoneAiPolicy }
  | { status: 'no_host' | 'no_connection' }
  | { status: 'no_zone' | 'no_permission' | 'unavailable'; host: string };

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

export async function readZoneAiPolicy(host: string | null | undefined, sources: ZoneSource[]): Promise<ZoneAiPolicyRead> {
  if (!host) return { status: 'no_host' };
  if (!sources.length) return { status: 'no_connection' };
  let unavailable = false;
  for (const source of sources) {
    let zone;
    try { zone = await findZone(source.provider, source.accountId, host); }
    catch { unavailable = true; continue; }
    if (!zone) continue;
    try {
      const settings = await source.provider(`/zones/${encodeURIComponent(zone.id)}/bot_management`);
      const value = (settings ?? {}) as Record<string, unknown>;
      return { status: 'read', policy: {
        zone: zone.name, host,
        ai_search: text(value.ai_search), ai_training: text(value.ai_training), ai_user: text(value.ai_user),
        ai_bots_protection: text(value.ai_bots_protection),
        managed_robots_txt: value.is_robots_txt_managed === true || value.bot_preference_sync_enabled === true,
      } };
    } catch (error) {
      const status = (error as { status?: number }).status;
      return status === 401 || status === 403 ? { status: 'no_permission', host } : { status: 'unavailable', host };
    }
  }
  return unavailable ? { status: 'unavailable', host } : { status: 'no_zone', host };
}

const blocks = (value: string | null) => value === 'block' || value === 'only_on_ad_pages';

export interface ZoneConflict {
  status: 'ok' | 'suggestion' | 'warning';
  message: string;
  fix: string;
  details: string[];
}

/**
 * Compare the zone's settings with the site's `ai_crawler_policy`. Edge
 * blocking always wins over robots.txt, and Cloudflare applies the strictest
 * rule to crawlers that do several jobs, so a Training block can stop
 * Googlebot, Bingbot and Applebot as well.
 */
export function compareZoneAiPolicy(policy: ZoneAiPolicy, sitePolicy: string): ZoneConflict {
  const details: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const trainingBlocked = blocks(policy.ai_training) || blocks(policy.ai_bots_protection);
  if (trainingBlocked) {
    details.push(`Training: ${policy.ai_training ?? policy.ai_bots_protection}`);
    warnings.push(`Cloudflare blocks AI training crawlers on ${policy.zone} at the edge. Cloudflare applies the strictest rule to crawlers that also index for search, so Googlebot, Bingbot and Applebot can be blocked too.`);
  }
  if (sitePolicy === 'allow_all') {
    if (blocks(policy.ai_search)) { details.push(`AI search: ${policy.ai_search}`); warnings.push('The zone blocks AI search crawlers, but the site allows all crawlers.'); }
    if (blocks(policy.ai_user)) { details.push(`AI agents: ${policy.ai_user}`); warnings.push('The zone blocks AI assistants and agents, but the site allows all crawlers.'); }
    if (policy.managed_robots_txt) warnings.push('Cloudflare prepends its own AI directives to robots.txt, which contradict the site setting that allows all crawlers.');
  } else if (sitePolicy === 'no_training' && blocks(policy.ai_user)) {
    details.push(`AI agents: ${policy.ai_user}`);
    warnings.push('The zone blocks AI assistants and agents, but the site allows answers and only declines training.');
  } else if (policy.managed_robots_txt) {
    suggestions.push('Both Cloudflare and Typeroll write AI directives to robots.txt. Turn off Cloudflare\'s managed robots.txt so the file has one author.');
  }
  if (policy.managed_robots_txt) details.push('Cloudflare managed robots.txt: on');
  const fix = 'In the Cloudflare dashboard, open the zone, then Security > Settings > Bot traffic: set the AI crawler policies to match the site, keep Training on "Allow" or robots.txt-only "Disallow" rather than "Block" if search visibility matters, and turn off managed robots.txt. Or change ai_crawler_policy in the site settings. Typeroll does not change zone settings.';
  if (warnings.length) return { status: 'warning', message: warnings.join(' '), fix, details };
  if (suggestions.length) return { status: 'suggestion', message: suggestions.join(' '), fix, details };
  return { status: 'ok', message: `The AI crawler settings of ${policy.zone} agree with the site setting.`, fix: 'None needed.', details };
}
