import type { APIRoute } from 'astro';
import { isSiteSettingsSection, scopedSettings } from '../../../../lib/site-settings-sections';
import { vstore } from '../../../../lib/version-store';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { TOKEN_SCALES, designScalesError, responsiveBreakpointsError, seoReviewError, externalRoutesError, defaultSiteSettings, normalizeIframeAllowedHosts, paths, isOnColorValue, ON_COLOR_TOKENS } from '@typeroll/shared';
import type { SiteSettings } from '@typeroll/shared';
import { normalizeOrganization, normalizeStagingUrl, normalizeTwitterHandle } from '../../../../lib/site-settings-fields';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const section = form.get('settings_section');
  if (section !== null && !isSiteSettingsSection(section)) return new Response('Unknown settings section.', { status: 400 });
  const includesSection = (id: string) => section === null || section === id;
  const store = getStore();
  const existing =
    (await vstore.settings(owner_org_id, site.id, versionId)) ?? defaultSiteSettings;

  // Flatten dotted form keys (e.g. colors.primary) into nested objects.
  const colors = { ...existing.colors };
  const fonts = { ...existing.fonts };

  // sameAs is one URL per line in the textarea.
  const organization = normalizeOrganization({
    name: String(form.get('organization.name') ?? ''),
    logo: String(form.get('organization.logo') ?? ''),
    same_as: String(form.get('organization.same_as') ?? '').split(/\r?\n/),
  });

  // Cookie consent — gated on the enabled checkbox. When unchecked we drop
  // the whole block so the renderer's `cookie_consent?.enabled === true`
  // check short-circuits. Script content is trusted like scripts_head:
  // admin-only via requirePermission('admin') above (the v1 settings PATCH
  // applies the same check), never exposed to the chat AI's
  // update_site_settings tool surface.
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
  const iframeHostCheck = normalizeIframeAllowedHosts(
    String(form.get('iframe_allowed_hosts') ?? '').split(/\r?\n/).map((host) => host.trim()).filter(Boolean),
  );
  if (includesSection('advanced') && iframeHostCheck.invalid.length) {
    return new Response(`Invalid iframe hostnames: ${iframeHostCheck.invalid.join(', ')}`, { status: 400 });
  }

  const lines = (key: string) => String(form.get(key) ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const external_routes = form.has('external_routes') ? lines('external_routes').map(line => {
    const divider = line.indexOf('|');
    return { path: (divider < 0 ? line : line.slice(0, divider)).trim(), owner: divider < 0 ? '' : line.slice(divider + 1).trim() };
  }) : existing.external_routes;
  const routesError = externalRoutesError(external_routes);
  if (includesSection('seo') && routesError) return new Response(routesError, { status: 400 });
  const seo_review = {
    forbidden_markers: lines('seo_review.forbidden_markers'),
    notes: lines('seo_review.notes'),
    claims: lines('seo_review.claims').map(line => { const divider = line.indexOf('|'); return { phrase: divider < 0 ? line : line.slice(0, divider).trim(), guidance: divider < 0 ? '' : line.slice(divider + 1).trim() }; }),
  };
  const reviewError = seoReviewError(seo_review);
  if (includesSection('seo') && reviewError) return new Response(reviewError, { status: 400 });
  const responsive_breakpoints = form.has('responsive_breakpoints.tablet')
    ? Object.fromEntries(['tablet', 'laptop', 'desktop', 'wide'].map(name => [name, Number(form.get(`responsive_breakpoints.${name}`))])) as NonNullable<SiteSettings['responsive_breakpoints']>
    : existing.responsive_breakpoints;
  const breakpointError = responsiveBreakpointsError(responsive_breakpoints);
  if (includesSection('design') && breakpointError) return new Response(breakpointError, { status: 400 });
  const agentInstructions = form.has('agent_instructions') ? String(form.get('agent_instructions') || '') : existing.agent_instructions;
  if (includesSection('access') && agentInstructions && agentInstructions.length > 12000) return new Response('Agent instructions must be at most 12000 characters.', { status: 400 });
  const next: SiteSettings = {
    ...existing,
    responsive_breakpoints,
    agent_instructions: agentInstructions,
    site_name: String(form.get('site_name') ?? existing.site_name),
    tagline: String(form.get('tagline') ?? '') || undefined,
    logo: String(form.get('logo') ?? '') || undefined,
    favicon: String(form.get('favicon') ?? '') || undefined,
    apple_touch_icon: String(form.get('apple_touch_icon') ?? '') || undefined,
    icon_192: String(form.get('icon_192') ?? '') || undefined,
    trailing_slash: ['always', 'never', 'ignore'].includes(String(form.get('trailing_slash')))
      ? String(form.get('trailing_slash')) as 'always' | 'never' | 'ignore'
      : 'always',
    iframe_allowed_hosts: iframeHostCheck.hosts,
    default_seo_suffix: String(form.get('default_seo_suffix') ?? '') || undefined,
    default_meta_description: String(form.get('default_meta_description') ?? '') || undefined,
    image_sizes_default: String(form.get('image_sizes_default') ?? '') || undefined,
    default_og_image: String(form.get('default_og_image') ?? '') || undefined,
    language: String(form.get('language') ?? 'en') || 'en',
    twitter_handle: normalizeTwitterHandle(String(form.get('twitter_handle') ?? '')),
    organization,
    scripts_head: String(form.get('scripts_head') ?? '') || undefined,
    scripts_body_end: String(form.get('scripts_body_end') ?? '') || undefined,
    robots_txt: String(form.get('robots_txt') ?? '') || undefined,
    sitewide_noindex: form.get('sitewide_noindex') === 'on',
    seo_review,
    external_routes,
    sitewide_nofollow: form.get('sitewide_nofollow') === 'on',
    cookie_consent,
    colors,
    fonts,
  };

  for (const key of ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'text_light'] as const) {
    const v = form.get(`colors.${key}`);
    if (typeof v === 'string' && v) colors[key] = v;
  }
  // Text on theme colours: "auto" clears the choice, "custom" stores the picked colour.
  for (const key of ON_COLOR_TOKENS) {
    const mode = form.get(`colors.${key}.mode`);
    const value = form.get(`colors.${key}`);
    if (mode === 'auto') delete colors[key];
    else if (mode === 'custom' && includesSection('design')) {
      if (!isOnColorValue(value)) return new Response(`colors.${key} must be a hex colour such as #ffffff`, { status: 400 });
      colors[key] = value.trim();
    }
  }
  const headingFont = form.get('fonts.heading');
  if (typeof headingFont === 'string' && headingFont) fonts.heading = headingFont;
  const bodyFont = form.get('fonts.body');
  if (typeof bodyFont === 'string' && bodyFont) fonts.body = bodyFont;
  const sizeBase = form.get('fonts.size_base');
  if (typeof sizeBase === 'string' && sizeBase) fonts.size_base = Number(sizeBase) || 16;
  const smoothing = form.get('fonts.smoothing');
  if (smoothing === 'auto' || smoothing === 'antialiased') fonts.smoothing = smoothing;
  else if (smoothing === '') delete fonts.smoothing;

  if (includesSection('design') && form.has('colors.surface_hover')) {
    const hover = String(form.get('colors.surface_hover') ?? '').trim();
    if (hover && !/^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$/.test(hover)) return new Response('Surface hover must be a hex colour or empty for automatic.', { status: 400 });
    if (hover) colors.surface_hover = hover; else delete colors.surface_hover;
  }
  if (includesSection('design') && form.has('fonts.mono')) {
    const mono = String(form.get('fonts.mono') ?? '').trim();
    if (mono) fonts.mono = mono; else delete fonts.mono;
  }
  if (includesSection('design') && form.has('design_scales.type_size.xs')) {
    const scales = Object.fromEntries(Object.entries(TOKEN_SCALES).map(([scale, steps]) => [scale, Object.fromEntries(Object.keys(steps).flatMap(step => {
      const value = String(form.get(`design_scales.${scale}.${step}`) ?? '').trim();
      return value ? [[step, value]] : [];
    }))]));
    const error = designScalesError(scales);
    if (error) return new Response(error, { status: 400 });
    next.design_scales = scales;
  }
  const settingsPath = paths.settings(owner_org_id, site.id, versionId);
  if (section === null) await store.setDoc(settingsPath, next as unknown as Record<string, unknown>);
  else if (section !== 'publishing') {
    // A second editor or agent may save another section while this request runs.
    // Replace atomically so cleared optional fields disappear without losing those edits.
    const patch = scopedSettings(next, section);
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const current = await store.getDoc<SiteSettings>(settingsPath);
      saved = await store.compareAndReplaceDoc(settingsPath, current, { ...existing, ...current, ...patch });
    }
    if (!saved) return new Response('Settings changed while saving. Your edits are still here; try saving again.', { status: 409 });
  }

  // Staging URL lives on the Site doc, not in versioned settings (so a
  // branch can't reroute it). The `domain` field is owned by the
  // dedicated lifecycle service now — /api/sites/{siteId}/domain — and
  // is NOT accepted here. Submitting a `domain` form field through this
  // endpoint is silently ignored. See docs/domain-lifecycle-plan.md.
  const siteUpdate: Record<string, unknown> = {};
  const stagingRaw = form.get('staging_url');
  if (includesSection('publishing') && typeof stagingRaw === 'string') siteUpdate.staging_url = normalizeStagingUrl(stagingRaw);
  if (Object.keys(siteUpdate).length > 0) {
    await store.updateDoc(paths.site(owner_org_id, site.id), siteUpdate);
  }

  if (request.headers.get('accept') === 'application/json') return Response.json({ saved: true, section });
  return redirect(`/app/sites/${site.id}/settings${section ? `?section=${section}&saved=1` : ''}`);
};
