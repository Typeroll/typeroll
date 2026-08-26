// Core-module descriptor types. App* names and the "apps" datastore path are
// retained for backward compatibility; the public product name "Typeroll
// Apps" means the separately sold product family, not these built-in modules. The
// registry is code-defined and the field schema
// drives the config form, encryption, and masking — same data-driven
// approach as the email providers, so a new app needs no changes to the
// route, the UI, or the crypto path.

import type { AppId, BlockType, Form, FormAction, FormField } from '@typeroll/shared';

/**
 * A form the app SHIPS. Enabling the app seeds it as a real Form doc and
 * registers a block that places it, so the operator picks "Edit listing" from
 * the block picker instead of wiring a form target by hand.
 *
 * `fields` is the app's BASE set. The site extends it through the ordinary
 * forms UI — an app form is a normal form once seeded, and re-enabling never
 * overwrites what the site added.
 */
export interface AppFormDef {
  /** Stable within the app; combined with the app id for the doc id. */
  id: string;
  name: string;
  /** Shown on the block in the picker. */
  label: string;
  icon?: string;
  description?: string;
  /** Base fields. The site may add its own alongside these. */
  fields: FormField[];
  /** Endpoint behaviour — see Form['target']. The app owns this, not the site. */
  target: Form['target'];
  /** Post-submit actions the app ships with the form. */
  actions?: FormAction[];
  /** Prefill sources the app ships with the form. */
  prefill?: FormAction[];
  submit_text?: string;
  success_message?: string;
}

export interface AppConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'boolean' | 'number' | 'select' | 'json';
  /** Secret fields are AES-encrypted at rest and never returned in plaintext. */
  secret?: boolean;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  help?: string;
  options?: string[];
}

export interface AppDef {
  id: AppId;
  name: string;
  description: string;
  category: 'insights' | 'i18n' | 'marketing';
  /** Enabling/disabling changes the customer-site build → prompts a redeploy. */
  affects_build?: boolean;
  /** Config field schema (drives the form + encryption + masking). */
  fields: AppConfigField[];
  /**
   * Config keys safe to write into a build snapshot (materialize) —
   * e.g. a public beacon token that must reach the page HTML. Everything
   * else (secrets, server-only ids) stays out of the customer site.
   */
  public_keys?: string[];
  /** App-specific validation after schema fields have been normalized. */
  validateConfig?: (config: Record<string, unknown>) => string | undefined;
  /**
   * Where a Form whose `target.app` names this app should POST.
   *
   * Exists so the forms module can stay app-agnostic: a form declares the
   * generic behaviours it needs (prefill, session exchange) and names an app;
   * the build asks that app where to send it. Adding a second app with a
   * remote-backed form is a registry entry, not a branch in the deploy runner.
   */
  formEndpoint?: (args: { siteId: string; portalUrl: string; form?: string }) => string;
  /**
   * Forms this app ships. Seeded as Form docs on enable, each with a block
   * that places it. See lib/apps/provision.ts.
   */
  forms?: AppFormDef[];
  /**
   * Extra block types registered when the app is enabled, beyond the one
   * generated per app form. Written into the site's own `block_types`
   * collection, so every surface that already reads that collection — picker,
   * renderer, preview, agent tools — sees them with no further wiring.
   */
  blocks?: BlockType[];
  /**
   * Form-action types this app contributes. They compose with core actions
   * and with other apps' — one form can email (core), post to Slack (a Slack
   * app) and enqueue moderation (this app) from a single `actions` list.
   * See lib/forms/actions.ts.
   */
  actions?: import('../forms/actions').FormActionDef[];
  /**
   * Prefill sources this app contributes — "fill this form from the listing
   * the visitor's edit link points at", and the like. Composes with core
   * sources and other apps' the same way actions do.
   */
  prefill_sources?: import('../forms/prefill').PrefillSourceDef[];
}
