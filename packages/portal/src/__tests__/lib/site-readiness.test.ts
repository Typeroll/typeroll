import { describe, expect, it } from 'vitest';
import { defaultSiteSettings, type Block, type Media, type Page, type Partial as PartialDoc, type SiteSettings } from '@typeroll/shared';
import { buildSiteReadiness, countH1, READINESS_ITEM_IDS, shareImageProblem, type ReadinessInput } from '../../lib/site-readiness';
import { compareZoneAiPolicy, readZoneAiPolicy, type ZoneAiPolicy } from '../../lib/publishing/zone-ai-policy';

const heading = (text: string, level = 'h2'): Block => ({ id: text, type: 'core/heading', data: { text, level } });
const page = (id: string, path: string, extra: Partial<Page> = {}): Page => ({
  id, title: id, slug: id, path, status: 'published', content_mode: 'blocks',
  blocks: [heading(`${id} title`, 'h1')], seo_description: `About ${id}.`, ...extra,
} as Page);
const nav = (paths: string[]): PartialDoc => ({ id: 'header', name: 'Header', kind: 'header', status: 'published',
  blocks: [{ id: 'nav', type: 'core/navigation_links', data: { links: paths.map(href => ({ label: href, href })) } }] } as unknown as PartialDoc);

function input(overrides: Partial<ReadinessInput> = {}, settings: Partial<SiteSettings> = {}): ReadinessInput {
  const pages = overrides.pages ?? [page('home', '/'), page('about', '/about/'), page('contact', '/contact/'), page('privacy', '/privacy/')];
  return {
    siteId: 'site', now: new Date('2026-11-01T12:00:00Z'),
    settings: { ...defaultSiteSettings, site_name: 'Acme', logo: '/logo.png', favicon: '/favicon.png', default_og_image: 'https://cdn.example/share.png',
      organization: { name: 'Acme', same_as: ['https://github.com/acme'] }, scripts_head: '<meta name="google-site-verification" content="x">', ...settings },
    pages, partials: overrides.partials ?? [nav(['/about/', '/contact/', '/privacy/'])], templates: [], contentTypes: [], blockTypes: [],
    media: overrides.media ?? [], apps: 'apps' in overrides ? overrides.apps! : { apps: { analytics: { enabled: true, config: {} } } } as never,
    links: overrides.links ?? { links: ['/about/', '/contact/', '/privacy/'].map(path => ({ from: 'partial:header', path })) },
    zone: overrides.zone ?? { status: 'no_host' },
  };
}
const byId = (report: ReturnType<typeof buildSiteReadiness>) => Object.fromEntries(report.items.map(item => [item.id, item]));

describe('site launch readiness', () => {
  it('returns every item id once, in contract order, with guide links', () => {
    const report = buildSiteReadiness(input());
    expect(report.items.map(item => item.id)).toEqual([...READINESS_ITEM_IDS]);
    expect(report.items.every(item => item.guide === `https://typeroll.com/docs/guides/launch-checklist/#${item.id.replace(/_/g, '-')}`)).toBe(true);
    expect(report.summary.ok + report.summary.suggestions + report.summary.warnings).toBe(READINESS_ITEM_IDS.length);
    expect(report.checked_at).toBe('2026-11-01T12:00:00.000Z');
  });

  it('passes a well-prepared site except for what it cannot know', () => {
    const items = byId(buildSiteReadiness(input()));
    const open = Object.values(items).filter(item => item.status !== 'ok').map(item => item.id);
    expect(open).toEqual([]);
  });

  it('treats a missing default share image as a suggestion and an SVG or small image as a warning', () => {
    expect(byId(buildSiteReadiness(input({}, { default_og_image: undefined }))).share_image.status).toBe('suggestion');
    expect(byId(buildSiteReadiness(input({}, { default_og_image: 'https://typeroll.com/og.svg' }))).share_image).toMatchObject({ status: 'warning', message: expect.stringContaining('SVG') });
    const media = [{ id: 'm', cdn_url: 'https://cdn.example/share.png', width: 400 } as Media];
    expect(byId(buildSiteReadiness(input({ media }))).share_image.message).toContain('400 px');
    expect(shareImageProblem('https://cdn.example/share.png', [])).toBeNull();
  });

  it('reports orphans, duplicate titles, long descriptions and H1 problems', () => {
    const pages = [
      page('home', '/'), page('about', '/about/', { title: 'Same', blocks: [] }), page('contact', '/contact/', { title: 'Same' }),
      page('privacy', '/privacy/', { seo_description: 'x'.repeat(161) }), page('lost', '/lost/', { blocks: [heading('a', 'h1'), heading('b', 'h1')] }),
    ];
    const items = byId(buildSiteReadiness(input({ pages })));
    expect(items.orphan_pages).toMatchObject({ status: 'warning', details: ['/lost/'] });
    expect(items.duplicate_titles.details).toEqual(['Same: /about/, /contact/']);
    expect(items.long_descriptions.details).toEqual(['/privacy/ (161)']);
    expect(items.heading_h1.details).toEqual(['/about/: 0 H1', '/lost/: 2 H1']);
  });

  it('does not count pages reached through a listing as orphans', () => {
    const pages = [page('home', '/', { blocks: [heading('Home', 'h1'), { id: 'list', type: 'core/listing', data: { content_type: 'article' } }] }),
      page('post', '/blog/post/', { content_type: 'article' })];
    const items = byId(buildSiteReadiness({ ...input({ pages, links: { links: [] } }), contentTypes: [{ id: 'article', name: 'article', label_singular: 'Article', label_plural: 'Articles', fields: [], url_pattern: '/blog/{slug}/' } as never] }));
    expect(items.orphan_pages.status).toBe('ok');
  });

  it('counts a Site title H1 in the header against every page', () => {
    const header = { ...nav(['/about/']), blocks: [{ id: 't', type: 'template/site_title', data: {} }] } as PartialDoc;
    expect(byId(buildSiteReadiness(input({ partials: [header] }))).heading_h1.status).toBe('warning');
    expect(countH1([{ id: 'hero', type: 'core/hero', data: { heading: 'Hi' } }], new Map())).toBe(1);
  });

  it('warns about trackers without consent and suggests analytics when there is none', () => {
    expect(byId(buildSiteReadiness(input({}, { scripts_head: '<script src="https://www.googletagmanager.com/gtag/js"></script>' }))).analytics_consent.status).toBe('warning');
    expect(byId(buildSiteReadiness(input({ apps: null }))).analytics_consent.status).toBe('suggestion');
  });

  it('turns typeroll.com-style custom CSS into font and override warnings', () => {
    const custom_css = "@font-face{font-family:'Inter';src:url(/i.woff2)}h1{font-family:'Fraunces',serif!important}.block-button-link{padding:0}";
    const items = byId(buildSiteReadiness(input({}, { custom_css })));
    expect(items.duplicate_fonts.status).toBe('warning');
    expect(items.custom_css_overrides.message).toContain('font not in the theme');
  });

  it('reports page JSON-LD problems', () => {
    const pages = [page('home', '/', { json_ld: JSON.stringify({ '@type': 'FAQPage', mainEntity: [] }) }), page('about', '/about/'), page('contact', '/contact/'), page('privacy', '/privacy/')];
    expect(byId(buildSiteReadiness(input({ pages }))).structured_data).toMatchObject({ status: 'warning', details: ['/: FAQPage is missing mainEntity.'] });
  });

  it('explains how to check the zone when the connection may not read bot settings', () => {
    const item = byId(buildSiteReadiness(input({ zone: { status: 'no_permission', host: 'example.com' } }))).ai_crawler_zone_conflict;
    expect(item.status).toBe('suggestion');
    expect(item.fix).toContain('Security > Settings > Bot traffic');
  });
});

describe('Cloudflare zone AI policy', () => {
  const policy = (patch: Partial<ZoneAiPolicy>): ZoneAiPolicy => ({ zone: 'example.com', host: 'example.com', ai_search: 'disabled', ai_training: 'disabled', ai_user: 'disabled', ai_bots_protection: 'disabled', managed_robots_txt: false, ...patch });

  it('agrees when nothing is blocked', () => {
    expect(compareZoneAiPolicy(policy({}), 'allow_all').status).toBe('ok');
  });

  it('warns that a Training block can also block search crawlers', () => {
    const result = compareZoneAiPolicy(policy({ ai_training: 'block' }), 'no_training');
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Googlebot, Bingbot and Applebot');
    expect(compareZoneAiPolicy(policy({ ai_bots_protection: 'only_on_ad_pages' }), 'allow_all').status).toBe('warning');
  });

  it('warns when managed robots.txt contradicts allow_all and suggests one author otherwise', () => {
    expect(compareZoneAiPolicy(policy({ managed_robots_txt: true }), 'allow_all').status).toBe('warning');
    expect(compareZoneAiPolicy(policy({ managed_robots_txt: true, ai_training: 'disallow' }), 'no_training').status).toBe('suggestion');
  });

  it('reads the zone through the connection and maps permission errors', async () => {
    const calls: string[] = [];
    const provider = async (route: string) => {
      calls.push(route);
      if (route.startsWith('/zones?')) return route.includes('name=example.com') ? [{ id: 'z1', name: 'example.com', status: 'active', account: { id: 'acc' } }] : [];
      return { ai_training: 'block', ai_search: 'disabled', ai_user: 'disabled', is_robots_txt_managed: true };
    };
    const read = await readZoneAiPolicy('www.example.com', [{ account: 'hosting', accountId: 'acc', provider }]);
    expect(read).toMatchObject({ status: 'read', policy: { zone: 'example.com', ai_training: 'block', managed_robots_txt: true } });
    expect(calls.at(-1)).toBe('/zones/z1/bot_management');

    const denied = async (route: string) => {
      if (route.startsWith('/zones?')) return [{ id: 'z1', name: 'example.com', status: 'active', account: { id: 'acc' } }];
      throw Object.assign(new Error('denied'), { status: 403 });
    };
    expect(await readZoneAiPolicy('example.com', [{ account: 'hosting', accountId: 'acc', provider: denied }])).toEqual({ status: 'no_permission', host: 'example.com' });
    expect(await readZoneAiPolicy('example.com', [])).toEqual({ status: 'no_connection' });
    expect(await readZoneAiPolicy(null, [])).toEqual({ status: 'no_host' });
  });
});
