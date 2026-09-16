// Built-in core-module registry. App* identifiers and paths.apps are legacy
// internal names retained for storage/API compatibility; they do not denote
// the separately sold Typeroll Apps product family.

import type { AppId } from '@typeroll/shared';
import type { AppDef } from './types';
import { analyticsApp } from './analytics';
import { integrationsApp } from './integrations';

export const APPS: Record<AppId, AppDef> = {
  analytics: analyticsApp,
  integrations: integrationsApp,
};

export function getAppDef(id: string): AppDef | undefined {
  return (APPS as Record<string, AppDef>)[id];
}

export function listAppDefs(): AppDef[] {
  return Object.values(APPS);
}
