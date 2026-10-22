// How the Analytics app's provider setup is described to read surfaces
// (portal, HTTP API, MCP). Pure: safe to import from build and projection code.

import type { AppSetupStatus, AppState } from '@typeroll/shared';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * The setup status to show for a stored state. States saved before setup was recorded are described from
 * their config, so an enabled app without a token is never reported as fine.
 */
export function analyticsSetupView(state: AppState | undefined): AppSetupStatus | null {
  if (!state?.enabled) return null;
  if (state.setup) return state.setup;
  const token = text(state.config?.beacon_token), tag = text(state.config?.site_tag);
  if (!token) {
    return {
      status: 'action_required', code: 'analytics_not_provisioned',
      message: 'Analytics is enabled, but no Cloudflare Web Analytics site is linked, so published pages carry no beacon.',
      next_step: 'Enable Analytics again (update_app with app_id "analytics" and enabled: true) to create the Web Analytics site in the Cloudflare account that hosts the site, then redeploy.',
      checked_at: state.enabled_at ?? new Date(0).toISOString(),
    };
  }
  if (!tag) {
    return {
      status: 'action_required', code: 'analytics_site_tag_missing',
      message: 'The beacon is published, but its site_tag is unknown, so Insights cannot read reports.',
      next_step: 'Enable Analytics again (update_app with app_id "analytics" and enabled: true) to find the token’s Web Analytics site in the hosting account.',
      checked_at: state.enabled_at ?? new Date(0).toISOString(),
    };
  }
  return null;
}
