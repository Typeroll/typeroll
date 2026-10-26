import type { SiteSettings } from '@typeroll/shared';

/** The form's scope is explicit: saving one section never resets another. */
export const SITE_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Your site name, identity and icons.' },
  { id: 'design', label: 'Design', description: 'Colors, typography and rendering.' },
  { id: 'seo', label: 'SEO', description: 'Search visibility, sharing and structured data.' },
  { id: 'publishing', label: 'Publishing', description: 'Hosting, domains and preview addresses for this site.' },
  { id: 'integrations', label: 'Integrations', description: 'Modules, email and cookie consent.' },
  { id: 'access', label: 'Access & AI', description: 'Sharing, API access and guidance for your AI agents.' },
  { id: 'advanced', label: 'Advanced', description: 'Custom scripts, content exports and site lifecycle.' },
] as const;
export type SiteSettingsSection = typeof SITE_SETTINGS_SECTIONS[number]['id'];
export function isSiteSettingsSection(value: unknown): value is SiteSettingsSection {
  return SITE_SETTINGS_SECTIONS.some(section => section.id === value);
}
export const SITE_SETTINGS_SECTION_FIELDS: Record<SiteSettingsSection, readonly (keyof SiteSettings)[]> = {
  general: ['site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192'],
  design: ['colors', 'fonts', 'design_scales', 'responsive_breakpoints', 'image_sizes_default'],
  seo: ['default_seo_suffix', 'default_meta_description', 'default_og_image', 'language', 'twitter_handle', 'organization', 'sitewide_noindex', 'sitewide_nofollow', 'seo_review', 'external_routes', 'robots_txt', 'trailing_slash'],
  publishing: [], // staging_url lives on the Site; domains have their own lifecycle.
  integrations: ['cookie_consent'],
  access: ['agent_instructions'],
  advanced: ['scripts_head', 'scripts_body_end', 'iframe_allowed_hosts'],
};
export function scopedSettings(next: SiteSettings, section: SiteSettingsSection): Partial<SiteSettings> {
  return Object.fromEntries(SITE_SETTINGS_SECTION_FIELDS[section].map(key => [key, next[key]]));
}
