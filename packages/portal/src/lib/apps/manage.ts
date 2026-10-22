import { paths } from '@typeroll/shared';
import type { AppSetupStatus, AppState, Site, SiteApps } from '@typeroll/shared';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { appSetupView, buildAppState } from './config';
import { reconcileWebAnalytics } from './provision-analytics';
import { provisionApp } from './provision';
import { getAppDef } from './registry';

export class AppManagementError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppManagementError';
  }
}

/** Body fields that describe an action-required setup, shared by the portal and bearer API error responses. */
export function setupErrorDetails(setup: AppSetupStatus): Record<string, unknown> {
  return {
    next_step: setup.next_step,
    ...(setup.settings_url ? { settings_url: setup.settings_url } : {}),
    ...(setup.account ? { account: setup.account } : {}),
  };
}

export interface SaveAppStateArgs {
  orgId: string;
  siteId: string;
  appId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  /** Provider HTTP client; tests pass a mock. */
  fetchImpl?: typeof fetch;
}

/**
 * Canonical app-state writer shared by the portal and bearer API. App-specific
 * provisioning belongs here so every authenticated surface gets identical
 * validation, encryption, side effects, and stored state.
 */
export async function saveAppState(args: SaveAppStateArgs): Promise<{
  state: AppState;
  affectsBuild: boolean;
  setup: AppSetupStatus | null;
}> {
  const def = getAppDef(args.appId);
  if (!def) throw new AppManagementError('Unknown app', 404);
  if (def.fields.some((field) => field.secret) && !isSecretCryptoConfigured()) {
    throw new AppManagementError(
      'App secrets cannot be saved: INTEGRATIONS_SECRET_KEY is not configured on the server.',
      503,
    );
  }

  const store = getStore();
  const existing = await store.getDoc<SiteApps>(paths.apps(args.orgId, args.siteId));
  const incoming = { ...(args.config ?? {}) };

  // Analytics: create or verify the Cloudflare Web Analytics site in the account that hosts this site.
  let setup: AppSetupStatus | undefined = existing?.apps?.[def.id]?.setup;
  if (args.appId === 'analytics' && args.enabled) {
    const site = await store.getDoc<Site>(paths.site(args.orgId, args.siteId));
    const result = await reconcileWebAnalytics({
      orgId: args.orgId, siteId: args.siteId, site, incoming, existing: existing?.apps?.analytics, fetchImpl: args.fetchImpl,
    });
    if (result.reject) {
      throw new AppManagementError(result.reject.message, 409, result.reject.code, setupErrorDetails(result.setup));
    }
    Object.assign(incoming, result.patch);
    setup = result.setup;
  }

  let state: AppState | string;
  try {
    state = buildAppState(args.appId, args.enabled, incoming, existing?.apps?.[def.id]);
  } catch (error) {
    throw new AppManagementError(
      error instanceof Error ? error.message : 'Failed to validate app config',
      500,
    );
  }
  if (typeof state === 'string') throw new AppManagementError(state, 400);
  if (setup) state.setup = setup;

  await store.setDoc(paths.apps(args.orgId, args.siteId), {
    ...(existing ?? {}),
    apps: { ...(existing?.apps ?? {}), [def.id]: state },
    updated_at: new Date().toISOString(),
  } satisfies SiteApps);

  // App-provided forms and blocks are derived surfaces. A provisioning
  // failure must not roll back valid app state; re-saving is idempotent.
  try {
    await provisionApp(args.orgId, args.siteId, def, args.enabled);
  } catch (error) {
    console.error(`[apps] provisioning ${args.appId} failed:`, error);
  }

  return { state, affectsBuild: Boolean(def.affects_build), setup: appSetupView(def.id, state) };
}

/**
 * The error a write surface returns when an enabled app was saved but cannot work yet: Analytics without a
 * beacon token. The saved state is included so callers can show it; calling again after the fix retries.
 */
export function incompleteSetupError(appId: string, state: AppState, setup: AppSetupStatus | null): AppManagementError | null {
  if (appId !== 'analytics' || !state.enabled || setup?.status !== 'action_required') return null;
  if (typeof state.config.beacon_token === 'string' && state.config.beacon_token) return null;
  return new AppManagementError(
    `Analytics was saved as enabled, but its Cloudflare Web Analytics site is not set up: ${setup.message}`,
    409, setup.code, setupErrorDetails(setup),
  );
}
