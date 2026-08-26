import type { APIRoute } from 'astro';
import { vstore } from '../../../../lib/version-store';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { defaultSiteSettings, paths } from '@typeroll/shared';
import type { SiteSettings } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const store = getStore();
  const existing =
    (await vstore.settings(owner_org_id, site.id, versionId)) ?? defaultSiteSettings;

  // Flatten dotted form keys (e.g. colors.primary) into nested objects.
  const colors = { ...existing.colors };
  const fonts = { ...existing.fonts };

  // sameAs is one URL per line in the textarea — split and trim.
  const sameAsRaw = String(form.get('organization.same_as') ?? '');
  const sameAs = sameAsRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const orgName = String(form.get('organization.name') ?? '').trim();
  const orgLogo = String(form.get('organization.logo') ?? '').trim();
  const organization =
    orgName || orgLogo || sameAs.length > 0
      ? {
          name: orgName || undefined,
          logo: orgLogo || undefined,
          same_as: sameAs,
        }
      : undefined;

  // Cookie consent — gated on the enabled checkbox. When unchecked we drop
  // the whole block so the renderer's `cookie_consent?.enabled === true`
  // check short-circuits. Script content is trusted like scripts_head:
  // admin-only via requirePermission('admin') above, never exposed to the
  // chat AI's update_site_settings tool surface.
  const ccEnabled = form.get('cookie_consent.enabled') === 'on';
  const cookie_consent = ccEnabled
    ? {
        enabled: true,
        text: String(form.get('cookie_consent.text') ?? '') || undefined,
        privacy_policy_url: String(form.get('cookie_consent.privacy_policy_url') ?? '').trim() || undefined,
        scripts_necessary: String(form.get('cookie_consent.scripts_necessary') ?? '') || undefined,
        scripts_optional: String(form.get('cookie_consent.scripts_optional') ?? '') || undefined,
        reload_after_consent: form.get('cookie_consent.reload_after_consent') === 'on',
      }
    : undefined;

  const next: SiteSettings = {
    ...existing,
    site_name: String(form.get('site_name') ?? existing.site_name),
    tagline: String(form.get('tagline') ?? '') || undefined,
    logo: String(form.get('logo') ?? '') || undefined,
    favicon: String(form.get('favicon') ?? '') || undefined,
    apple_touch_icon: String(form.get('apple_touch_icon') ?? '') || undefined,
    default_seo_suffix: String(form.get('default_seo_suffix') ?? '') || undefined,
    default_meta_description: String(form.get('default_meta_description') ?? '') || undefined,
    image_sizes_default: String(form.get('image_sizes_default') ?? '') || undefined,
    default_og_image: String(form.get('default_og_image') ?? '') || undefined,
    language: String(form.get('language') ?? 'en') || 'en',
    twitter_handle: String(form.get('twitter_handle') ?? '').replace(/^@/, '') || undefined,
    organization,
    scripts_head: String(form.get('scripts_head') ?? '') || undefined,
    scripts_body_end: String(form.get('scripts_body_end') ?? '') || undefined,
    custom_css: String(form.get('custom_css') ?? '') || undefined,
    robots_txt: String(form.get('robots_txt') ?? '') || undefined,
    cookie_consent,
    colors,
    fonts,
  };

  for (const key of ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'text_light'] as const) {
    const v = form.get(`colors.${key}`);
    if (typeof v === 'string' && v) colors[key] = v;
  }
  const headingFont = form.get('fonts.heading');
  if (typeof headingFont === 'string' && headingFont) fonts.heading = headingFont;
  const bodyFont = form.get('fonts.body');
  if (typeof bodyFont === 'string' && bodyFont) fonts.body = bodyFont;
  const sizeBase = form.get('fonts.size_base');
  if (typeof sizeBase === 'string' && sizeBase) fonts.size_base = Number(sizeBase) || 16;

  await store.setDoc(paths.settings(owner_org_id, site.id, versionId), next as unknown as Record<string, unknown>);

  // Staging URL lives on the Site doc, not in versioned settings (so a
  // branch can't reroute it). The `domain` field is owned by the
  // dedicated lifecycle service now — /api/sites/{siteId}/domain — and
  // is NOT accepted here. Submitting a `domain` form field through this
  // endpoint is silently ignored. See docs/domain-lifecycle-plan.md.
  const siteUpdate: Record<string, unknown> = {};
  const stagingRaw = form.get('staging_url');
  if (typeof stagingRaw === 'string') {
    const cleaned = stagingRaw.trim().replace(/\/+$/, '');
    siteUpdate.staging_url = cleaned || null;
  }
  if (Object.keys(siteUpdate).length > 0) {
    await store.updateDoc(paths.site(owner_org_id, site.id), siteUpdate);
  }

  return redirect(`/app/sites/${site.id}/settings`);
};
