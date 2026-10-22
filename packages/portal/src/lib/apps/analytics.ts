// The analytics app — the first Typeroll app. When enabled for a site it
// (1) injects a Cloudflare Web Analytics beacon into the published site
// (cookieless, privacy-friendly) and (2) unlocks the Insights dashboard
// (traffic, Core Web Vitals, AI-assistant referral breakdown).
//
// Config:
//   - beacon_token: CF Web Analytics token embedded in every page's HTML.
//     Public (it's a client beacon token) → materialized into the build.
//     Created on enable in the Cloudflare account that hosts the site (the
//     Hosting Group account for customer publishing, the installation's
//     account otherwise); a pasted token is resolved in that same account.
//     See provision-analytics.ts and analytics-account.ts.
//   - site_tag: CF RUM site tag used SERVER-SIDE to read stats via the CF
//     GraphQL API. Not embedded in the page; stays out of the build snapshot.

import { analyticsEventRules } from './analytics-event-policy';
import type { AppDef } from './types';

export const analyticsApp: AppDef = {
  id: 'analytics',
  name: 'Analytics',
  description:
    'Privacy-friendly traffic analytics and Core Web Vitals via Cloudflare Web Analytics, ' +
    'plus AI-assistant referral tracking (visits from ChatGPT, Claude, Perplexity, …). ' +
    'Adds a lightweight cookieless beacon to your published site.',
  category: 'insights',
  affects_build: true,
  validateConfig(config) { return config.event_rules !== undefined && !analyticsEventRules(config.event_rules) ? 'Invalid Analytics event rules' : undefined; },
  fields: [
    { key: 'event_rules', label: 'Allowed conversion events', type: 'json', default: [], help: 'Explicit event names, destinations and allowed parameters. Unlisted events are rejected.' },
    {
      key: 'beacon_token',
      label: 'Cloudflare Web Analytics token',
      type: 'text',
      placeholder: '00000000000000000000000000000000',
      help: 'Filled automatically: enabling Analytics creates a Web Analytics site in the Cloudflare account ' +
        'that hosts this site. You can instead paste the token of a Web Analytics site you created in that account ' +
        '(Analytics & Logs → Web Analytics); Insights can only read that account.',
    },
    {
      key: 'site_tag',
      label: 'Site tag (for reading stats)',
      type: 'text',
      help: 'Filled automatically from the token. Used only to read Insights.',
    },
  ],
  // Only the beacon token is embedded in the page; site_tag is server-only.
  public_keys: ['beacon_token'],
};
