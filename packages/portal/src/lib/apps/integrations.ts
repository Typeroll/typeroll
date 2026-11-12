// The integrations app — one app, ~20 third-party tags.
//
// Why one app rather than twenty: the per-site state is a single AppState
// doc with a flat config map, and the config-form / encryption / masking /
// build-projection machinery is already schema-driven (apps/config.ts). So a
// catalog of providers collapses into one AppDef whose `fields` are derived,
// and adding a provider is a catalog entry with no platform change at all.
//
// The value is not "you couldn't do this before" — you could, by pasting the
// vendor's script into settings.scripts_head. The value is that the snippet
// becomes reviewed platform code around a validated identifier: versioned
// with the release, fixable centrally when a vendor changes their embed, and
// visible as a labelled field in the portal instead of buried in a textarea.
//
// The catalog itself lives in @typeroll/shared because the site-template
// renderer needs it at build time too.

import {
  FORM_CONVERSION_KEYS,
  INTEGRATION_PROVIDERS,
  integrationConfigKey,
} from '@typeroll/shared';
import type { AppConfigField, AppDef } from './types';

/** Catalog → flat config fields (`meta_pixel__pixel_id`, …). */
function catalogFields(): AppConfigField[] {
  const out: AppConfigField[] = [];
  for (const p of INTEGRATION_PROVIDERS) {
    for (const f of p.fields) {
      out.push({
        key: integrationConfigKey(p.id, f.key),
        // Disambiguate in a flat form: "Meta Pixel (Facebook) — Pixel ID".
        label: `${p.name} — ${f.label}`,
        type: 'text',
        placeholder: f.placeholder,
        // None of these are secrets. They ship to every visitor's browser by
        // design; marking them `secret` would encrypt them at rest and then
        // mask them back to the owner who needs to verify what they pasted.
        secret: false,
        help: f.help ?? p.docs,
      });
    }
  }
  return out;
}

// A provider is "on" when its fields are filled — there's no separate
// per-provider toggle. One field instead of two per provider keeps a
// 20-provider form readable, and "clear the ID to turn it off" is
// unambiguous.
//
// There is also no consent switch here. The platform already has one
// (`SiteSettings.cookie_consent`, with a banner and a script-activation
// runtime that predates this app), so integration tags simply route through
// it: anything outside the `necessary` category is held by the SAME gate that
// holds `cookie_consent.scripts_optional`. A second consent mechanism owned
// by this app would be a second thing to get wrong.

// Form conversions (shared/form-conversions.ts). The browser side needs only
// the provider IDs above plus the mode and the email notice, which are public.
// The Conversions API token is a secret: encrypted at rest, masked on read,
// never projected into a build. The test code and the email-matching switch
// are read server-side only, but neither is sensitive.
const conversionFields: AppConfigField[] = [
  {
    key: FORM_CONVERSION_KEYS.mode,
    label: 'Form conversions',
    type: 'select',
    options: ['auto', 'on', 'off'],
    default: 'auto',
    help: 'After a successful form submission, send one conversion event through Meta Pixel, GA4 and Google Tag Manager, after cookie consent. "auto" turns it on from render version 20.',
  },
  {
    key: FORM_CONVERSION_KEYS.capiToken,
    label: 'Meta Conversions API — access token',
    type: 'password',
    secret: true,
    help: 'Optional. Also sends each form conversion from the server, with the same event id, so Meta counts it once. Create the token in Events Manager → Settings → Conversions API.',
  },
  {
    key: FORM_CONVERSION_KEYS.capiTestCode,
    label: 'Meta Conversions API — test event code',
    type: 'text',
    placeholder: 'TEST12345',
    help: 'Used only by "Send a test conversion". Copy it from Events Manager → Test events.',
  },
  {
    key: FORM_CONVERSION_KEYS.capiEmailMatching,
    label: 'Meta Conversions API — match by email',
    type: 'boolean',
    default: false,
    help: 'Off by default. When on, the server also sends a SHA-256 hash of the email address, also for visitors who did not accept cookies. Needs a notice below, shown on the forms.',
  },
  {
    key: FORM_CONVERSION_KEYS.capiEmailNotice,
    label: 'Meta Conversions API — notice on forms',
    type: 'text',
    help: 'Shown above the submit button of forms with an email field while email matching is on, for example "We share a coded version of your email address with Meta to measure our ads."',
  },
];

function validateConversions(config: Record<string, unknown>): string | undefined {
  const mode = config[FORM_CONVERSION_KEYS.mode];
  if (mode !== undefined && mode !== 'auto' && mode !== 'on' && mode !== 'off')
    return 'Form conversions is "auto", "on" or "off".';
  if (config[FORM_CONVERSION_KEYS.capiEmailMatching] === true) {
    const notice = config[FORM_CONVERSION_KEYS.capiEmailNotice];
    if (typeof notice !== 'string' || notice.trim().length < 20)
      return 'Matching by email needs a notice of at least 20 characters to show on the forms.';
    if (!config[`${FORM_CONVERSION_KEYS.capiToken}_enc`])
      return 'Matching by email needs a Conversions API access token.';
  }
  const code = config[FORM_CONVERSION_KEYS.capiTestCode];
  if (code !== undefined && (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)))
    return 'The test event code is letters and digits, as Events Manager shows it.';
  return undefined;
}

export const integrationsApp: AppDef = {
  id: 'integrations',
  name: 'Integrations',
  description:
    'Add analytics, advertising pixels, and support widgets by pasting an ID instead of a script tag. ' +
    'Covers Google Analytics, GTM, Meta, LinkedIn, TikTok, Hotjar, Clarity, Intercom and more. ' +
    'Each snippet is maintained by Typeroll, so a vendor changing their embed is our problem, not yours.',
  category: 'marketing',
  affects_build: true,
  fields: [...catalogFields(), ...conversionFields],
  validateConfig: validateConversions,
  // Every catalog field is a public client-side identifier — embedded in the
  // page HTML by definition. Of the conversion fields only the mode and the
  // email notice reach the page; the token never does.
  public_keys: [
    ...catalogFields().map((f) => f.key),
    FORM_CONVERSION_KEYS.mode,
    FORM_CONVERSION_KEYS.capiEmailMatching,
    FORM_CONVERSION_KEYS.capiEmailNotice,
  ],
};
