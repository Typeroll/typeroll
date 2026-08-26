// The analytics app — the first Typeroll app. When enabled for a site it
// (1) injects a Cloudflare Web Analytics beacon into the published site
// (cookieless, privacy-friendly) and (2) unlocks the Insights dashboard
// (traffic, Core Web Vitals, AI-assistant referral breakdown).
//
// Config:
//   - beacon_token: CF Web Analytics token embedded in every page's HTML.
//     Public (it's a client beacon token) → materialized into the build.
//     Auto-provisioned via the CF API when the platform has CF creds + the
//     site has a domain; otherwise the owner pastes it from the CF dashboard.
//   - site_tag: CF RUM site tag used SERVER-SIDE to read stats via the CF
//     GraphQL API. Not embedded in the page; stays out of the build snapshot.

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
  fields: [
    {
      key: 'beacon_token',
      label: 'Cloudflare Web Analytics token',
      type: 'text',
      placeholder: '00000000000000000000000000000000',
      help: 'Auto-filled when we can provision it for you. Otherwise create a Web Analytics ' +
        'site in the Cloudflare dashboard (Analytics & Logs → Web Analytics) and paste the token.',
    },
    {
      key: 'site_tag',
      label: 'Site tag (for reading stats)',
      type: 'text',
      help: 'Auto-filled on provisioning. Only needed to show the Insights dashboard.',
    },
  ],
  // Only the beacon token is embedded in the page; site_tag is server-only.
  public_keys: ['beacon_token'],
};
