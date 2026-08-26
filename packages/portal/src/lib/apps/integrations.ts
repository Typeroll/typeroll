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

export const integrationsApp: AppDef = {
  id: 'integrations',
  name: 'Integrations',
  description:
    'Add analytics, advertising pixels, and support widgets by pasting an ID instead of a script tag. ' +
    'Covers Google Analytics, GTM, Meta, LinkedIn, TikTok, Hotjar, Clarity, Intercom and more. ' +
    'Each snippet is maintained by Typeroll, so a vendor changing their embed is our problem, not yours.',
  category: 'marketing',
  affects_build: true,
  fields: catalogFields(),
  // Every one of these is a public client-side identifier — they're embedded
  // in the page HTML by definition, so the whole config is the public
  // projection. Nothing here is a secret being leaked into the build.
  public_keys: catalogFields().map((f) => f.key),
};
