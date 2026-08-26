import { validateFunnelAttributionConfig } from '@typeroll/shared';
import type { AppDef } from './types';

export const funnelAttributionApp: AppDef = {
  id: 'funnel_attribution',
  name: 'Analytics · Attribution',
  description:
    'Forward allowlisted campaign parameters to exact outbound links, emit optional analytics events, ' +
    'and optionally persist first- or last-touch attribution after consent.',
  category: 'insights',
  affects_build: true,
  fields: [
    {
      key: 'funnels',
      label: 'Funnel rules (JSON)',
      type: 'json',
      required: true,
      default: [],
      placeholder: '[{"id":"campaign","parameters":[],"targets":[]}]',
      help: 'Rules match page paths and exact HTTPS target host/path pairs. Only declared parameters are forwarded.',
    },
    {
      key: 'allow_personal_data',
      label: 'Allow personal-data parameters',
      type: 'boolean',
      default: false,
      help: 'Warning: enabling this allows rules for email, name, phone and similar fields. Leave off for campaign attribution.',
    },
    {
      key: 'allow_synthetic_fallbacks',
      label: 'Allow synthetic fallback attribution',
      type: 'boolean',
      default: false,
      help: 'Explicitly permits fallback values when no incoming or stored campaign value exists. Leave off to preserve only real attribution.',
    },
  ],
  public_keys: ['funnels', 'allow_personal_data', 'allow_synthetic_fallbacks'],
  validateConfig(config) {
    const errors = validateFunnelAttributionConfig({
      funnels: config.funnels,
      allow_personal_data: config.allow_personal_data === true,
      allow_synthetic_fallbacks: config.allow_synthetic_fallbacks === true,
    });
    return errors.length ? errors.join('; ') : undefined;
  },
};
