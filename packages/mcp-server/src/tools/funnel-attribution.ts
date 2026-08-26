import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

const parameter = z.object({
  from: z.string().describe('Allowlisted incoming query-parameter name.'),
  to: z.string().optional().describe('Outgoing name. Defaults to from.'),
  fallback: z.string().optional().describe(
    'Synthetic value added when URL and stored attribution have no value. Omit it when the goal is to preserve real campaign attribution. Requires allow_synthetic_fallbacks=true.',
  ),
  max_length: z.number().int().min(1).max(1024).optional(),
});

const target = z.object({
  type: z.literal('link'),
  protocol: z.literal('https:').optional(),
  host: z.string().describe('Exact target hostname, for example calendly.com.'),
  path: z.string().describe('Exact target pathname, beginning with /.'),
  click_event: z.string().optional().describe('Optional conversion-event name. Typeroll Analytics records it when enabled; gtag also receives it when installed. Navigation is never delayed.'),
  destination: z.string().optional().describe('Event label for the destination.'),
});

const storage = z.object({
  enabled: z.boolean().describe('Persist only real allowlisted values from the current URL.'),
  ttl_days: z.number().int().min(1).max(365).optional().describe('Cookie lifetime. Defaults to 30 days.'),
  touch: z.enum(['first_touch', 'last_touch', 'both']).optional().describe('Which consent-gated attribution snapshots to write.'),
  read_touch: z.enum(['first_touch', 'last_touch']).optional().describe('Which stored snapshot supplies a missing current value.'),
  consent: z.literal('optional').optional().describe('Cookies are written only after the visitor accepts optional cookies.'),
  cookie_domain: z.string().optional(),
});

const funnel = z.object({
  id: z.string(),
  page_paths: z.array(z.string()).optional(),
  source: z.enum(['current_url', 'current_or_stored']).optional(),
  parameters: z.array(parameter).min(1).max(32),
  targets: z.array(target).min(1).max(50),
  precedence: z.enum(['source_over_target', 'target_over_source']).optional(),
  storage: storage.optional(),
});

export const funnelAttributionTools: ToolDef[] = [
  {
    name: 'read_funnel_attribution',
    description: 'Read the Analytics attribution module and its validated forwarding/storage rules. Admin permission required.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      return ok(await client.get(siteId, 'apps/funnel_attribution'));
    }),
  },
  {
    name: 'update_funnel_attribution',
    description:
      'Enable, configure, or disable the Analytics attribution module. Rules forward only allowlisted query parameters to exact HTTPS host/path targets. ' +
      'Read the current config before writing. For campaign pass-through, omit fallback values: fallbacks create synthetic attribution rather than preserving ad parameters. ' +
      'Optional first/last-touch cookies persist only real incoming values and are written only after optional consent. A target click_event becomes a validated, non-blocking first-party conversion event when Analytics is enabled. This changes the customer build, so redeploy after saving. Admin permission required.',
    inputSchema: {
      enabled: z.boolean(),
      funnels: z.array(funnel).max(50),
      allow_personal_data: z.boolean().optional().describe('Explicitly permit email/name/phone-like parameter names. Keep false for campaign attribution.'),
      allow_synthetic_fallbacks: z.boolean().optional().describe(
        'Explicit acknowledgement that configured fallback values invent attribution when no incoming or stored value exists. Keep false when preserving advertising parameters.',
      ),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      return ok(await client.put(siteId, 'apps/funnel_attribution', {
        enabled: args.enabled,
        config: {
          funnels: args.funnels,
          allow_personal_data: args.allow_personal_data ?? false,
          allow_synthetic_fallbacks: args.allow_synthetic_fallbacks ?? false,
        },
      }));
    }),
  },
];
