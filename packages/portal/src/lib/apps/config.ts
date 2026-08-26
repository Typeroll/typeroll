// Generic, schema-driven app config handling — the apps analogue of
// email/connector-config.ts. Encryption, masking, decryption, and the
// build-snapshot projection are all driven from an app's declared field
// schema, so no per-app code is needed here.

import type { AppId, AppState, AppStateMap, SiteApps } from '@typeroll/shared';
import { encryptSecret, decryptSecret, SECRET_MASK } from '../secret-crypto';
import { getAppDef, listAppDefs } from './registry';

function isNewSecret(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v !== SECRET_MASK;
}

/**
 * Build a stored AppState from UI input: validate against the app's field
 * schema, encrypt new secrets, preserve unchanged ones (mask sentinel or
 * omitted). Returns the state or a validation-error string.
 */
export function buildAppState(
  appId: string,
  enabled: boolean,
  incoming: Record<string, unknown>,
  existing: AppState | undefined,
): AppState | string {
  const def = getAppDef(appId);
  if (!def) return `Unknown app "${appId}"`;

  const config: Record<string, unknown> = {};
  for (const f of def.fields) {
    const raw = incoming[f.key];
    if (f.secret) {
      const encKey = `${f.key}_enc`;
      if (isNewSecret(raw)) config[encKey] = encryptSecret(raw);
      else if (existing?.config?.[encKey] !== undefined) config[encKey] = existing.config[encKey];
      // Only enforce required-secret when actually enabling the app.
      if (enabled && f.required && config[encKey] === undefined) return `${f.label} is required`;
    } else {
      let v: unknown = raw;
      if (f.type === 'number') v = raw === '' || raw == null ? undefined : Number(raw);
      else if (f.type === 'boolean') v = raw == null ? undefined : raw === true || raw === 'true' || raw === 'on';
      else if (f.type === 'json' && typeof raw === 'string') {
        try {
          v = JSON.parse(raw);
        } catch {
          return `${f.label} must be valid JSON`;
        }
      }
      // Preserve an existing non-secret value when the incoming one is empty
      // or omitted — so disabling (or a partial save) never discards config;
      // re-enabling stays one click. Only a real new value overwrites.
      if (v === undefined || v === '') v = existing?.config?.[f.key];
      if (enabled && f.required && (v === undefined || v === null || v === '')) return `${f.label} is required`;
      if (v !== undefined && v !== '') config[f.key] = v;
    }
  }

  const validationError = def.validateConfig?.(config);
  if (enabled && validationError) return validationError;

  return {
    enabled,
    config,
    enabled_at: enabled ? (existing?.enabled_at ?? new Date().toISOString()) : undefined,
  };
}

export interface MaskedAppState {
  enabled: boolean;
  enabled_at?: string;
  /** field key → raw value (non-secret) or { set: boolean } (secret). */
  config: Record<string, unknown>;
}

/** AppState → UI-safe shape; never includes ciphertext or plaintext secrets. */
export function maskAppState(appId: string, s: AppState | undefined): MaskedAppState {
  const def = getAppDef(appId);
  const config: Record<string, unknown> = {};
  for (const f of def?.fields ?? []) {
    if (f.secret) config[f.key] = { set: Boolean(s?.config?.[`${f.key}_enc`]) };
    else config[f.key] = s?.config?.[f.key] ?? '';
  }
  return { enabled: Boolean(s?.enabled), enabled_at: s?.enabled_at, config };
}

/** AppState → decrypted config for server-side use (dashboard, provisioning). */
export function resolveAppConfig(appId: string, s: AppState): Record<string, unknown> {
  const def = getAppDef(appId);
  const values: Record<string, unknown> = {};
  for (const f of def?.fields ?? []) {
    if (f.secret) {
      const enc = s.config?.[`${f.key}_enc`];
      values[f.key] = typeof enc === 'string' && enc ? decryptSecret(enc) : '';
    } else {
      values[f.key] = s.config?.[f.key] ?? f.default ?? '';
    }
  }
  return values;
}

/**
 * The PUBLIC projection written into build snapshots: enabled apps only,
 * and only each app's declared `public_keys` (never secrets or server-only
 * config). This is the exact doc the customer-site renderer reads.
 */
export function publicAppsSnapshot(doc: SiteApps | undefined): SiteApps {
  const out: AppStateMap = {};
  for (const def of listAppDefs()) {
    const state = doc?.apps?.[def.id];
    if (!state?.enabled) continue;
    const publicConfig: Record<string, unknown> = {};
    for (const key of def.public_keys ?? []) {
      const v = state.config?.[key];
      if (v !== undefined && v !== '') publicConfig[key] = v;
    }
    out[def.id] = { enabled: true, config: publicConfig };
  }
  return { apps: out };
}

export function isAppEnabled(doc: SiteApps | undefined, appId: AppId): boolean {
  return Boolean(doc?.apps?.[appId]?.enabled);
}
