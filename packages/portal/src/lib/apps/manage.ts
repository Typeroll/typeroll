import { paths } from '@typeroll/shared';
import type { AppState, Site, SiteApps } from '@typeroll/shared';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { buildAppState } from './config';
import { maybeProvisionWebAnalytics } from './provision-analytics';
import { provisionApp } from './provision';
import { getAppDef } from './registry';

export class AppManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AppManagementError';
  }
}

export interface SaveAppStateArgs {
  orgId: string;
  siteId: string;
  appId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

/**
 * Canonical app-state writer shared by the portal and bearer API. App-specific
 * provisioning belongs here so every authenticated surface gets identical
 * validation, encryption, side effects, and stored state.
 */
export async function saveAppState(args: SaveAppStateArgs): Promise<{
  state: AppState;
  affectsBuild: boolean;
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

  if (args.appId === 'analytics' && args.enabled) {
    const site = await store.getDoc<Site>(paths.site(args.orgId, args.siteId));
    Object.assign(
      incoming,
      await maybeProvisionWebAnalytics(site ?? undefined, incoming, existing?.apps?.analytics),
    );
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

  return { state, affectsBuild: Boolean(def.affects_build) };
}
