// Site launch readiness: one site-level report of what a site needs to be
// found, shared and understood, built from saved content and settings.
// Every item is a warning or a suggestion with a one-line fix and a guide
// link. Nothing here blocks a publication or changes content.

import {
  DEFAULT_CONTENT_TYPE, checkJsonLd, lintSiteCss, paths, resolveContentPage,
  type Block, type BlockType, type ContentType, type CssLintFinding, type Media, type Page,
  type AppId, type PageTemplate, type Partial as PartialDoc, type Site, type SiteApps, type SiteSettings,
} from '@typeroll/shared';
import type { ReadWriteStore } from './datastore';
import { checkInternalLinks, type InternalLinkReport } from './internal-link-check';
import { vstore } from './version-store';
import { compareZoneAiPolicy, type ZoneAiPolicyRead } from './publishing/zone-ai-policy';

export const READINESS_ITEM_IDS = [
  'share_image', 'home_description', 'organization', 'same_as', 'favicon', 'analytics_consent', 'search_console',
  'privacy_page', 'contact_page', 'not_found_page',
  'indexable_pages', 'orphan_pages', 'duplicate_titles', 'duplicate_descriptions', 'heading_h1', 'long_descriptions',
  'duplicate_fonts', 'custom_css_overrides',
  'ai_crawler_zone_conflict', 'structured_data',
] as const;
export type ReadinessItemId = (typeof READINESS_ITEM_IDS)[number];
export type ReadinessStatus = 'ok' | 'suggestion' | 'warning';

export interface ReadinessItem {
  id: ReadinessItemId;
  status: ReadinessStatus;
  message: string;
  fix: string;
  guide: string;
  /** Affected pages or values, at most 20. */
  details?: string[];
}

export interface SiteReadinessReport {
  site_id: string;
  checked_at: string;
  summary: { ok: number; suggestions: number; warnings: number };
  items: ReadinessItem[];
}

export const LAUNCH_CHECKLIST_URL = 'https://typeroll.com/docs/guides/launch-checklist/';
export const MAX_DESCRIPTION_LENGTH = 160;
const MAX_DETAILS = 20;

export function readinessGuide(id: ReadinessItemId): string {
  return `${LAUNCH_CHECKLIST_URL}#${id.replace(/_/g, '-')}`;
}

export interface ReadinessInput {
  siteId: string;
  settings: SiteSettings;
  pages: Page[];
  partials: PartialDoc[];
  templates: PageTemplate[];
  contentTypes: ContentType[];
  blockTypes: BlockType[];
  media: Media[];
  apps: SiteApps | null;
  links: Pick<InternalLinkReport, 'links'>;
  zone: ZoneAiPolicyRead;
  now?: Date;
}

const LIVE = new Set(['published', 'unlisted']);
const PRIVACY = /privacy|integritet|datenschutz|tietosuoja|personvern|privatliv|persondata|confidentialit|privacidad|privacidade|cookie|gdpr|dataskydd/i;
const CONTACT = /contact|kontakt|yhteystied|contacto|contatt|contato|kontaktai/i;
const TRACKERS = /googletagmanager\.com|gtag\(|google-analytics\.com|connect\.facebook\.net|fbq\(|hotjar\.com|clarity\.ms|snap\.licdn\.com|analytics\.tiktok\.com/i;

function list(values: string[]): string[] | undefined {
  return values.length ? values.slice(0, MAX_DETAILS) : undefined;
}

function urlPath(value: string): string {
  try { return new URL(value, 'https://site.invalid').pathname.toLowerCase(); } catch { return value.toLowerCase(); }
}

/** Why a share image will not show as a card, or null when it will. */
export function shareImageProblem(url: string, media: Media[]): string | null {
  if (/^data:/i.test(url)) return 'is an inline data URL, which social networks do not load';
  const entry = media.find(item => item.cdn_url === url || item.published_url === url);
  if (urlPath(url).endsWith('.svg') || entry?.mime_type === 'image/svg+xml') return 'is an SVG, which Facebook, LinkedIn, X and Slack do not render';
  if (entry?.width && entry.width < 600) return `is ${entry.width} px wide; share cards need at least 600 px (1200 × 630 is recommended)`;
  return null;
}

type BlockVisitor = (block: Block) => void;
function walk(blocks: Block[] | undefined, visit: BlockVisitor) {
  for (const block of blocks ?? []) {
    visit(block);
    walk(block.children, visit);
    for (const slot of block.slots ?? []) walk(slot, visit);
  }
}

/** H1 elements a block tree renders, from block data and custom block templates. */
export function countH1(blocks: Block[] | undefined, blockTypes: Map<string, BlockType>): number {
  let count = 0;
  walk(blocks, block => {
    const level = typeof block.data?.level === 'string' ? block.data.level : undefined;
    switch (block.type) {
      case 'core/heading': case 'core/rich_heading': if (level === 'h1') count++; break;
      case 'template/page_title': case 'template/site_title': if ((level ?? 'h1') === 'h1') count++; break;
      case 'core/hero': if (typeof block.data?.heading === 'string' && block.data.heading.trim()) count++; break;
      default: {
        const type = blockTypes.get(block.type);
        if (type?.origin !== 'core' && typeof type?.template === 'string') count += (type.template.match(/<h1\b/gi) ?? []).length;
        if (typeof block.data?.html === 'string') count += (block.data.html.match(/<h1\b/gi) ?? []).length;
      }
    }
  });
  return count;
}

function listedContentTypes(blocks: Block[] | undefined, into: Set<string>) {
  walk(blocks, block => {
    const data = block.data ?? {};
    if (typeof data.content_type === 'string' && data.content_type) into.add(data.content_type);
    if (Array.isArray(data.content_types)) for (const type of data.content_types) if (typeof type === 'string') into.add(type);
  });
}

function item(id: ReadinessItemId, status: ReadinessStatus, message: string, fix: string, details?: string[]): ReadinessItem {
  return { id, status, message, fix, guide: readinessGuide(id), ...(details?.length ? { details: details.slice(0, MAX_DETAILS) } : {}) };
}

const CSS_LABEL: Record<CssLintFinding['code'], string> = {
  css_important_overuse: 'heavy !important use',
  css_font_not_in_theme: 'font not in the theme',
  css_first_section_background_image: 'first-section background image',
  css_block_class_override: 'rules on platform block classes',
  css_duplicate_font_load: 'duplicate font load',
};

/** Build the report from loaded data. Pure apart from the clock. */
export function buildSiteReadiness(input: ReadinessInput): SiteReadinessReport {
  const { settings, media } = input;
  const items: ReadinessItem[] = [];
  const types = new Map(input.contentTypes.map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const blockTypes = new Map(input.blockTypes.map(type => [type.id, type]));
  const templates = new Map(input.templates.map(template => [template.id, template]));
  const resolved = input.pages.flatMap(page => {
    const type = types.get(page.content_type ?? 'page');
    const value = type ? resolveContentPage(page, type) : null;
    return value ? [value] : [];
  });
  const live = resolved.filter(page => LIVE.has(page.status));
  const indexable = live.filter(page => page.status === 'published' && !page.noindex && !settings.sitewide_noindex);
  const label = (page: Page) => page.path ?? `/${page.slug}`;
  const home = live.find(page => page.path === '/');
  const partials = input.partials.filter(partial => partial.status === 'published');

  // share_image
  const share = settings.default_og_image?.trim();
  const pageImages = live.flatMap(page => {
    const problem = page.og_image ? shareImageProblem(page.og_image, media) : null;
    return problem ? [`${label(page)}: share image ${problem}`] : [];
  });
  if (share) {
    const problem = shareImageProblem(share, media);
    if (problem || pageImages.length) {
      items.push(item('share_image', 'warning', problem ? `The default share image ${problem}.` : `${pageImages.length} page share image${pageImages.length === 1 ? '' : 's'} will not show as a card.`,
        'Use a PNG or JPEG of at least 1200 × 630 px as default_og_image and as page og_image.', pageImages));
    } else items.push(item('share_image', 'ok', 'A default share image is set.', 'None needed.'));
  } else {
    items.push(item('share_image', pageImages.length ? 'warning' : 'suggestion',
      pageImages.length ? `No default share image, and ${pageImages.length} page share image${pageImages.length === 1 ? '' : 's'} will not show as a card.` : 'No default share image. Pages without their own image fall back to the logo when shared.',
      'Optional: upload or choose a 1200 × 630 px image, or create one with tr-imagegen, and set it as default_og_image.', pageImages));
  }

  // home_description
  const homeDescription = home?.seo_description?.trim() || settings.default_meta_description?.trim() || settings.tagline?.trim();
  if (!home) items.push(item('home_description', 'warning', 'The site has no published home page at /.', 'Publish a Page with the path /.'));
  else if (!home.seo_description?.trim()) {
    items.push(item('home_description', homeDescription ? 'suggestion' : 'warning',
      homeDescription ? 'The home page uses the site-wide fallback description.' : 'The home page has no meta description.',
      'Write a specific seo_description for the home page that says what the site offers.'));
  } else items.push(item('home_description', 'ok', 'The home page has its own description.', 'None needed.'));

  // organization
  const orgName = settings.organization?.name || settings.site_name;
  const orgLogo = settings.organization?.logo || settings.logo;
  if (!orgName || !orgLogo) {
    items.push(item('organization', 'suggestion', `Organization structured data has no ${!orgName ? 'name' : 'logo'}.`,
      'Set organization.name and organization.logo (a square PNG or JPEG) in the site settings.'));
  } else items.push(item('organization', 'ok', 'Organization name and logo are set.', 'None needed.'));

  // same_as
  const profiles = [...(settings.organization?.same_as ?? []), ...Object.values(settings.social ?? {})].filter(value => typeof value === 'string' && value.trim());
  items.push(profiles.length
    ? item('same_as', 'ok', `${profiles.length} profile link${profiles.length === 1 ? '' : 's'} connect the site to the organization.`, 'None needed.')
    : item('same_as', 'suggestion', 'No social or company profile links.', 'Add official profiles (LinkedIn, GitHub, Wikipedia and similar) to organization.same_as or the social settings.'));

  // favicon
  items.push(settings.favicon
    ? item('favicon', 'ok', 'A favicon is set.', 'None needed.')
    : item('favicon', 'warning', 'No favicon. Browsers and Google search results show a generic icon.', 'Upload a square icon and set favicon in the site settings.'));

  // analytics_consent
  const appsOn = (id: AppId) => Boolean(input.apps?.apps?.[id]?.enabled);
  const scriptTrackers = TRACKERS.test(`${settings.scripts_head ?? ''}\n${settings.scripts_body_end ?? ''}`);
  const consent = settings.cookie_consent?.enabled === true;
  if ((appsOn('integrations') || scriptTrackers) && !consent) {
    items.push(item('analytics_consent', 'warning', scriptTrackers ? 'Tracking scripts load without a cookie banner.' : 'Third-party tags are enabled without a cookie banner.',
      'Turn on cookie_consent and load tags through the Integrations app, so they wait for consent.'));
  } else if (appsOn('analytics') || appsOn('integrations') || scriptTrackers) {
    items.push(item('analytics_consent', 'ok', consent ? 'Analytics runs with a cookie banner.' : 'Cookieless analytics is enabled.', 'None needed.'));
  } else {
    items.push(item('analytics_consent', 'suggestion', 'No analytics is set up, so visits and AI referrals are not measured.', 'Enable the Analytics app (cookieless) or add your tags in the Integrations app with the cookie banner on.'));
  }

  // search_console
  items.push(/google-site-verification/i.test(settings.scripts_head ?? '')
    ? item('search_console', 'ok', 'A Google Search Console verification tag is present.', 'Submit /sitemap.xml in Search Console if you have not.')
    : item('search_console', 'suggestion', 'Typeroll cannot tell whether the site is verified in Google Search Console; DNS verification is not visible to it.',
      'Verify the domain in Search Console (a DNS record is preferred) and submit /sitemap.xml. Bing Webmaster Tools can import it from Search Console.'));

  // privacy_page / contact_page / not_found_page
  const matches = (re: RegExp) => live.find(page => re.test(label(page)) || re.test(page.title));
  const privacy = matches(PRIVACY) || settings.cookie_consent?.privacy_policy_url;
  const needsPrivacy = consent || appsOn('integrations') || scriptTrackers;
  items.push(privacy
    ? item('privacy_page', 'ok', 'A privacy page is published.', 'None needed.')
    : item('privacy_page', needsPrivacy ? 'warning' : 'suggestion', 'No privacy or cookie policy page found.',
      'Publish a privacy page, link it in the footer, and set cookie_consent.privacy_policy_url.'));
  items.push(matches(CONTACT) || settings.contact?.email || settings.contact?.phone
    ? item('contact_page', 'ok', 'Visitors can find contact details.', 'None needed.')
    : item('contact_page', 'suggestion', 'No contact page or contact details found.', 'Publish a contact page or set contact details in the site settings.'));
  items.push(item('not_found_page', 'ok', 'Every publication includes a 404 page with the site header and footer, and one per language section.', 'None needed.'));

  // indexable_pages
  if (settings.sitewide_noindex) items.push(item('indexable_pages', 'warning', 'The whole site is set to noindex, so search engines will not list it.', 'Turn off sitewide_noindex when the site is ready to be found.'));
  else if (indexable.length <= 1) items.push(item('indexable_pages', 'suggestion', `Only ${indexable.length} indexable page${indexable.length === 1 ? '' : 's'}. One page can rank for only a few searches.`, 'Give each product, service or question its own page.'));
  else items.push(item('indexable_pages', 'ok', `${indexable.length} pages can be indexed.`, 'None needed.'));

  // orphan_pages
  const liveSources = new Set([...live.map(page => `page:${page.id}`), ...partials.map(partial => `partial:${partial.id}`), ...input.templates.filter(t => t.status === 'published').map(t => `template:${t.id}`)]);
  const listed = new Set<string>();
  for (const page of live) listedContentTypes(page.blocks, listed);
  for (const partial of partials) listedContentTypes(partial.blocks, listed);
  for (const template of input.templates) listedContentTypes(template.blocks, listed);
  const norm = (path: string) => path.replace(/\/+$/, '') || '/';
  const linked = new Map<string, Set<string>>();
  for (const link of input.links.links ?? []) {
    if (!liveSources.has(link.from)) continue;
    const set = linked.get(norm(link.path)) ?? new Set<string>();
    set.add(link.from); linked.set(norm(link.path), set);
  }
  const orphans = indexable.filter(page => page.path !== '/' && !listed.has(page.content_type ?? 'page')
    && ![...(linked.get(norm(label(page))) ?? [])].some(from => from !== `page:${page.id}`));
  items.push(orphans.length
    ? item('orphan_pages', 'warning', `${orphans.length} indexable page${orphans.length === 1 ? ' is' : 's are'} not linked from any other page, menu or listing.`, 'Link each page from a related page, a menu or a listing so visitors and crawlers can reach it.', orphans.map(label))
    : item('orphan_pages', 'ok', 'Every indexable page is linked from somewhere else.', 'None needed.'));

  // duplicate_titles / duplicate_descriptions / long_descriptions
  const groups = (key: (page: Page) => string | undefined) => {
    const map = new Map<string, Page[]>();
    for (const page of indexable) { const value = key(page)?.trim().toLowerCase(); if (value) map.set(value, [...(map.get(value) ?? []), page]); }
    return [...map.values()].filter(group => group.length > 1);
  };
  const titleGroups = groups(page => page.seo_title || page.title);
  items.push(titleGroups.length
    ? item('duplicate_titles', 'warning', `${titleGroups.length} title${titleGroups.length === 1 ? ' is' : 's are'} shared by several pages.`, 'Give each page a title that says what is different about it.', titleGroups.map(group => `${group[0].seo_title || group[0].title}: ${group.map(label).join(', ')}`))
    : item('duplicate_titles', 'ok', 'Page titles are unique.', 'None needed.'));
  const descriptionGroups = groups(page => page.seo_description);
  const missingDescription = indexable.filter(page => !page.seo_description?.trim() && page.path !== '/');
  if (descriptionGroups.length || missingDescription.length > 1) {
    const details = [...descriptionGroups.map(group => `Same description: ${group.map(label).join(', ')}`), ...(missingDescription.length > 1 ? [`Fall back to the site description: ${missingDescription.map(label).join(', ')}`] : [])];
    items.push(item('duplicate_descriptions', 'warning', `${descriptionGroups.length + (missingDescription.length > 1 ? 1 : 0)} description${descriptionGroups.length + (missingDescription.length > 1 ? 1 : 0) === 1 ? ' is' : 's are'} shared by several pages.`, 'Write a specific seo_description for each page.', details));
  } else items.push(item('duplicate_descriptions', 'ok', 'Page descriptions are unique.', 'None needed.'));
  const long = indexable.filter(page => (page.seo_description?.trim().length ?? 0) > MAX_DESCRIPTION_LENGTH);
  items.push(long.length
    ? item('long_descriptions', 'warning', `${long.length} description${long.length === 1 ? ' is' : 's are'} longer than ${MAX_DESCRIPTION_LENGTH} characters and may be cut off in search results.`, `Keep seo_description under ${MAX_DESCRIPTION_LENGTH} characters, with the key point first.`, long.map(page => `${label(page)} (${page.seo_description!.trim().length})`))
    : item('long_descriptions', 'ok', `Descriptions fit in ${MAX_DESCRIPTION_LENGTH} characters.`, 'None needed.'));

  // heading_h1
  const shared = partials.reduce((sum, partial) => sum + (partial.kind === 'free' ? 0 : countH1(partial.blocks, blockTypes)), 0);
  const h1Problems = indexable.flatMap(page => {
    const own = page.content_mode === 'html' || (!page.blocks?.length && page.html_content) ? (page.html_content?.match(/<h1\b/gi) ?? []).length : countH1(page.blocks, blockTypes);
    const fromTemplate = page.template ? countH1(templates.get(page.template)?.blocks, blockTypes) : 0;
    const total = own + fromTemplate + shared;
    return total === 1 ? [] : [`${label(page)}: ${total} H1`];
  });
  items.push(h1Problems.length
    ? item('heading_h1', 'warning', `${h1Problems.length} page${h1Problems.length === 1 ? ' has' : 's have'} no H1 or more than one.`, 'Give each page exactly one H1 that names its topic; use H2 for sections. A Site title block in the header should not be an H1.', h1Problems)
    : item('heading_h1', 'ok', 'Every indexable page has one H1.', 'None needed.'));

  // duplicate_fonts / custom_css_overrides
  const css = lintSiteCss(settings, [
    ...live.map(page => ({ kind: 'page' as const, id: page.id, css: page.custom_css, blocks: page.blocks })),
    ...partials.map(partial => ({ kind: 'partial' as const, id: partial.id, blocks: partial.blocks })),
    ...input.templates.map(template => ({ kind: 'template' as const, id: template.id, blocks: template.blocks })),
    ...input.blockTypes.filter(type => type.origin !== 'core').map(type => ({ kind: 'block_type' as const, id: type.id, css: type.styles })),
  ]);
  const dupFonts = css.filter(finding => finding.code === 'css_duplicate_font_load');
  items.push(dupFonts.length
    ? item('duplicate_fonts', 'warning', `${[...new Set(dupFonts.map(f => f.value))].join(', ')} ${dupFonts.length === 1 ? 'is' : 'are'} loaded again next to the theme's own font loading.`, dupFonts[0].alternative, dupFonts.map(f => `${f.source} ${f.path}: ${f.value}`))
    : item('duplicate_fonts', 'ok', 'Theme fonts are loaded once.', 'None needed.'));
  const overrides = css.filter(finding => finding.code !== 'css_duplicate_font_load');
  items.push(overrides.length
    ? item('custom_css_overrides', 'warning', `Custom CSS works against the theme: ${[...new Set(overrides.map(f => CSS_LABEL[f.code]))].join(', ')}.`, 'Run lint_design_tokens for each finding and the Style, token or block setting that replaces it.', overrides.map(f => `${f.source} ${f.path}: ${f.message}`))
    : item('custom_css_overrides', 'ok', 'Custom CSS does not override the theme.', 'None needed.'));

  // ai_crawler_zone_conflict
  const sitePolicy = ['allow_all', 'no_training', 'block_all'].includes(String((settings as { ai_crawler_policy?: unknown }).ai_crawler_policy))
    ? String((settings as { ai_crawler_policy?: unknown }).ai_crawler_policy) : 'allow_all';
  const dashboard = 'Check the zone in the Cloudflare dashboard under Security > Settings > Bot traffic: the AI crawler policies (Search, Training, Agents) and managed robots.txt should match the site\'s ai_crawler_policy. A Training "Block" can also block Googlebot, Bingbot and Applebot.';
  const zone = input.zone;
  if (zone.status === 'read') {
    const result = compareZoneAiPolicy(zone.policy, sitePolicy);
    items.push(item('ai_crawler_zone_conflict', result.status, result.message, result.fix, result.details));
  } else if (zone.status === 'no_host') {
    items.push(item('ai_crawler_zone_conflict', 'ok', 'The site has no website host yet, so no zone policy applies.', 'None needed.'));
  } else {
    const message = zone.status === 'no_permission' ? `The Cloudflare connection may not read bot settings for ${zone.host}.`
      : zone.status === 'no_zone' ? `${zone.host} is not in a connected Cloudflare account, so its AI crawler settings could not be compared.`
        : zone.status === 'unavailable' ? `Cloudflare did not answer the bot settings check for ${zone.host}.`
          : 'No Cloudflare connection, so the zone\'s AI crawler settings could not be compared.';
    items.push(item('ai_crawler_zone_conflict', 'suggestion', message, dashboard));
  }

  // structured_data
  const jsonLd = live.flatMap(page => checkJsonLd(page.json_ld).map(issue => `${label(page)}: ${issue.message}${issue.path && issue.path !== '.' ? ` (${issue.path})` : ''}`));
  items.push(jsonLd.length
    ? item('structured_data', 'warning', `${jsonLd.length} structured-data problem${jsonLd.length === 1 ? '' : 's'} in page JSON-LD.`, 'Add the missing properties or fix the dates and URLs; remove schema that does not match visible content.', jsonLd)
    : item('structured_data', 'ok', 'Page JSON-LD has the required properties.', 'None needed.'));

  const order = new Map(READINESS_ITEM_IDS.map((id, index) => [id, index]));
  items.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    site_id: input.siteId,
    checked_at: (input.now ?? new Date()).toISOString(),
    summary: {
      ok: items.filter(entry => entry.status === 'ok').length,
      suggestions: items.filter(entry => entry.status === 'suggestion').length,
      warnings: items.filter(entry => entry.status === 'warning').length,
    },
    items,
  };
}

/** Load saved content for a site and version and build the report. */
export async function readSiteReadiness(args: {
  store: ReadWriteStore;
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site & { id: string };
  readZone: () => Promise<ZoneAiPolicyRead>;
}): Promise<SiteReadinessReport> {
  const { store, orgId, siteId, versionId } = args;
  const [settings, pages, partials, templates, contentTypes, blockTypes, media, apps, links, zone] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.contentTypes(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId),
    store.listDocs<Media>(paths.media(orgId, siteId)),
    store.getDoc<SiteApps>(paths.apps(orgId, siteId)),
    checkInternalLinks({ store, orgId, siteId, versionId, site: args.site, includeLinks: true }),
    args.readZone().catch(() => ({ status: 'unavailable', host: args.site.domain ?? '' }) as ZoneAiPolicyRead),
  ]);
  if (!settings) throw new Error('Site settings not found');
  return buildSiteReadiness({ siteId, settings, pages, partials, templates, contentTypes, blockTypes, media, apps: apps ?? null, links, zone });
}
