// Where a form's initial values come from.
//
// Same SHAPE as actions — a declared list on the form, resolved through a
// registry that core seeds and apps extend — but deliberately a SEPARATE
// registry, because the contract is different in three ways that matter:
//
//   Actions run after; prefill runs before render.
//   Actions are side-effect-only; prefill RETURNS data.
//   An action's failure is swallowed (the thing already happened); a prefill
//     failure is partial data, so it degrades rather than disappears.
//
// Folding the two into one type would produce a handler that sometimes
// returns values and whose failure sometimes matters — a union that reads
// elegant and behaves badly. Two registries, one idea.
//
// Sources compose in declaration order, later ones winning, so a site can put
// an app's source first and override individual fields after it.

import type { Form } from '@typeroll/shared';
import type { AppConfigField } from '../apps/types';

export interface PrefillContext {
  orgId: string;
  siteId: string;
  /** Query parameters of the page the form is on. */
  query: Record<string, string>;
  /** Session the form runtime holds, when it has one (see Form.target). */
  sessionToken?: string;
}

export interface PrefillSourceDef {
  type: string;
  label: string;
  description?: string;
  config_fields?: AppConfigField[];
  /**
   * Values keyed by field name. Unknown names are dropped by the caller — a
   * source can't invent fields, only fill declared ones.
   */
  resolve: (
    config: Record<string, unknown>,
    ctx: PrefillContext,
  ) => Promise<Record<string, unknown>>;
}

const CORE_SOURCES: PrefillSourceDef[] = [
  {
    type: 'query',
    label: 'From the page URL',
    description: 'Fill fields from query parameters, e.g. ?plan=pro on a signup link.',
    config_fields: [
      {
        key: 'map', label: 'Parameter → field', type: 'text',
        help: 'Comma-separated pairs, e.g. "plan=chosen_plan, ref=referrer". Omit to use matching names.',
      },
    ],
    resolve: async (config, ctx) => {
      const raw = String(config.map ?? '').trim();
      if (!raw) return { ...ctx.query };
      const out: Record<string, unknown> = {};
      for (const pair of raw.split(',')) {
        const [param, field] = pair.split('=').map((x) => x.trim());
        if (param && field && ctx.query[param] !== undefined) out[field] = ctx.query[param];
      }
      return out;
    },
  },
  {
    type: 'constant',
    label: 'Fixed values',
    description: 'Set a field to the same value every time.',
    config_fields: [
      { key: 'values', label: 'field=value pairs', type: 'text', help: 'e.g. "source=website, lang=sv"' },
    ],
    resolve: async (config) => {
      const out: Record<string, unknown> = {};
      for (const pair of String(config.values ?? '').split(',')) {
        const [field, ...rest] = pair.split('=');
        const name = field?.trim();
        if (name && rest.length) out[name] = rest.join('=').trim();
      }
      return out;
    },
  },
];

let registry: Map<string, PrefillSourceDef> | null = null;

/** Core sources plus every source the apps contribute. */
export async function prefillRegistry(): Promise<Map<string, PrefillSourceDef>> {
  if (registry) return registry;
  registry = new Map(CORE_SOURCES.map((s) => [s.type, s]));
  // Dynamic, for the same cycle reason as the action registry — and never a
  // runtime require, which doesn't exist in ESM.
  const { listAppDefs } = await import('../apps/registry');
  for (const app of listAppDefs()) {
    for (const s of app.prefill_sources ?? []) {
      if (!registry.has(s.type)) registry.set(s.type, s);
    }
  }
  return registry;
}

export function _resetPrefillRegistryForTests(): void {
  registry = null;
}

/**
 * Resolve a form's initial values.
 *
 * `allowedFields` is the caller's whitelist — normally the form's own field
 * names. A source that returns something else is ignored rather than trusted,
 * so a misconfigured source can't smuggle a value into a field the form
 * doesn't have.
 */
export async function resolvePrefill(
  form: Pick<Form, 'prefill'>,
  ctx: PrefillContext,
  allowedFields: string[],
): Promise<{ values: Record<string, unknown>; failed: string[] }> {
  const reg = await prefillRegistry();
  const allowed = new Set(allowedFields);
  const values: Record<string, unknown> = {};
  const failed: string[] = [];

  for (const source of form.prefill ?? []) {
    const def = reg.get(source.type);
    if (!def) {
      console.warn(`[form prefill] no handler for source "${source.type}"`);
      continue;
    }
    try {
      const got = await def.resolve(source.config ?? {}, ctx);
      // Later sources win, so a site can put an app's source first and
      // override single fields after it.
      for (const [k, v] of Object.entries(got)) {
        if (allowed.has(k) && v !== undefined) values[k] = v;
      }
    } catch (e) {
      // A partial prefill still beats an empty form, so this degrades rather
      // than failing the render.
      failed.push(source.type);
      console.error(`[form prefill] source "${source.type}" failed:`, e);
    }
  }
  return { values, failed };
}
