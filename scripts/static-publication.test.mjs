import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRenderPlan } from '../packages/site-template/src/lib/publication-render-cache.mjs';
import { projectStaticPublication, createStaticPublicationProject, sealPublicationProject } from './lib/static-publication.mjs';

function input() {
  return {
    site: { name: 'Synthetic Site', domain: 'example.invalid', hosting_config: { token: 'private-value' } },
    settings: { site_name: 'Synthetic Site', colors: { primary: '#112233', private: 'private-value' }, fonts: { heading: 'system-ui', body: 'system-ui', size_base: 16 }, _internal: 'private-value' },
    pages: [
      { id: 'home', slug: '', title: 'Home', status: 'published', content_mode: 'html', html_content: '<h1>Public</h1><img src="https://media.example.invalid/one.png" />', api_generated: true, editor_email: 'private-value' },
      { id: 'draft', slug: 'draft', status: 'draft', content_mode: 'html', html_content: 'private-value' },
    ],
    partials: [{ id: 'footer', name: 'Footer', kind: 'footer', status: 'published', content_mode: 'html', html_content: '<footer>Public footer</footer>', working_copy: 'private-value' }],
    media: [
      { id: 'image', filename: 'one.png', cdn_url: 'https://media.example.invalid/one.png', width: 64, height: 32, uploaded_by: 'private-value', r2_key: 'private-value', variants: [{ cdn_url: 'https://media.example.invalid/one.webp', format: 'webp', width: 64, size_bytes: 100, internal: 'private-value' }] },
      { id: 'unused', filename: 'private.png', cdn_url: 'https://media.example.invalid/private.png', title: 'private-value' },
    ],
    forms: [], extensions: [], contentTypes: [], blockTypes: [], pageTemplates: [], redirects: [], apps: null,
  };
}
const identity = { siteUrl: 'https://example.invalid', coreCommit: 'a'.repeat(40), publishedAt: '2026-09-06T12:00:00Z' };

test('publication preserves browser keys in projected Extension public configuration', () => {
  const browserKey = 'AIza' + 'syntheticBrowserKey'.repeat(3);
  const value = input();
  value.publicRuntime = { extensions: { installations: [{ installation_id: 'installed-one', public_config: { places_browser_key: browserKey } }] } };
  assert.equal(projectStaticPublication(value, identity).extensions.installations[0].public_config.places_browser_key, browserKey);
});

test('credential protection still rejects browser keys in content and private keys in public configuration', () => {
  const browserKey = 'AIza' + 'syntheticBrowserKey'.repeat(3);
  const value = input(); value.pages[0].html_content = '<p>' + browserKey + '</p>';
  assert.throws(() => projectStaticPublication(value, identity), /Credential-like/);
  for (const secret of ['ghp_' + 'a'.repeat(36), '-----BEGIN PRIVATE KEY-----']) {
    const configured = input();
    configured.publicRuntime = { extensions: { installations: [{ public_config: { browser_key: secret } }] } };
    assert.throws(() => projectStaticPublication(configured, identity), /Credential-like/);
  }
  const misplaced = input();
  misplaced.publicRuntime = { extensions: { installations: [{ components: [{ public_config: { key: browserKey } }] }] } };
  assert.throws(() => projectStaticPublication(misplaced, identity), /Credential-like/);
});

test('publication preserves redirect IDs derived from file paths and wildcard routes', () => {
  const value = input();
  value.redirects = [
    { id: 'legacy.html', from_path: '/legacy.html', to_path: '/new', status_code: 301 },
    { id: '__splat', from_path: '/*', to_path: '/archive/:splat', status_code: 302 },
    { id: '_hidden', from_path: '/_hidden', to_path: '/new', status_code: 301 },
  ];
  assert.deepEqual(projectStaticPublication(value, identity).redirects,
    [...value.redirects].sort((a, b) => a.id < b.id ? -1 : 1));
});

test('redirect identities reject unsafe paths, empty IDs and duplicates', () => {
  const value = input();
  const redirect = { id: 'legacy.html', from_path: '/legacy.html', to_path: '/new', status_code: 301 };
  for (const id of ['', '.', '..', '../outside', 'nested/path', 'nested\\\\path', 'id\n', 'a'.repeat(129)]) {
    value.redirects = [{ ...redirect, id }];
    assert.throws(() => projectStaticPublication(value, identity), /Invalid publication redirect ID/);
  }
  value.redirects = [redirect, { ...redirect, from_path: '/other' }];
  assert.throws(() => projectStaticPublication(value, identity), /Duplicate public document ID/);
});

test('publishes optional page fields cleared by a full API replacement without accepting malformed values', () => {
  const value = input();
  Object.assign(value.pages[0], { noindex: null, alternates: null, blocks: null, template: null, seo_title: null });
  const publication = projectStaticPublication(value, identity);
  assert.equal(publication.pages[0].html_content, value.pages[0].html_content);
  assert.ok(!Object.hasOwn(publication.pages[0], 'noindex'));
  assert.ok(!Object.hasOwn(publication.pages[0], 'alternates'));
  value.pages[0].noindex = 'false';
  assert.throws(() => projectStaticPublication(value, identity), /Invalid public flag: noindex/);
  value.pages[0].noindex = false; value.pages[0].alternates = 'invalid';
  assert.throws(() => projectStaticPublication(value, identity), /Invalid publication language alternatives/);
});

const coreBlockTypes = [
  { id: 'core/section', schema: [{ name: 'background', type: 'color' }] },
  { id: 'core/heading', schema: [{ name: 'text', type: 'text' }, { name: 'level', type: 'select' }, { name: 'editor_note', type: 'text', rendered: false }] },
];

test('block publication preserves nested responsive content and excludes editorial data', () => {
  const value = input();
  value.pages[0] = { ...value.pages[0], content_mode: 'blocks', custom_css: 'h1 { color: blue; }', blocks: [{
    id: 'section-one', type: 'core/section', name: 'private-value', data: { background: '#fff', unknown: 'private-value' },
    children: [{ id: 'heading-one', type: 'core/heading', data: { text: 'Block publication', level: 'h1', editor_note: 'private-value' },
      responsive: { mobile: { hidden: false, data_overrides: { text: 'Mobile title', editor_note: 'private-value' } } },
      style_overrides: { custom_class: 'public-heading', editor: 'private-value' } }],
  }] };
  delete value.pages[0].html_content;
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes });
  assert.equal(publication.pages[0].blocks[0].children[0].data.text, 'Block publication');
  assert.equal(publication.pages[0].blocks[0].children[0].responsive.mobile.data_overrides.text, 'Mobile title');
  assert.equal(publication.pages[0].custom_css, 'h1 { color: blue; }');
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  value.pages[0].blocks[0].children[0].type = 'unknown/backend';
  assert.throws(() => projectStaticPublication(value, { ...identity, coreBlockTypes }), /Unsupported publication block/);
});

test('public projection removes private fields, drafts, internal nested data and unused media', () => {
  const projected = projectStaticPublication(input(), identity);
  assert.equal(projected.pages.length, 1);
  assert.equal(projected.media.length, 1);
  assert.equal(projected.media[0].variants[0].cdn_url, 'https://media.example.invalid/one.webp');
  assert.equal(projected.settings.colors.primary, '#112233');
  assert.equal(projected.settings.sitewide_noindex, true);
  assert.ok(!JSON.stringify(projected).includes('private-value'));
  assert.ok(!JSON.stringify(projected).includes('api_generated'));
});

test('unsupported modules and data structures fail instead of silently losing site behavior', () => {
  for (const key of ['forms', 'extensions']) {
    assert.throws(() => projectStaticPublication({ ...input(), [key]: [{ id: 'feature' }] }, identity), /public runtime projection/);
  }
  assert.throws(() => projectStaticPublication({ ...input(), contentTypes: [{ id: 'feature' }] }, identity), /Invalid publication content type/);
  assert.throws(() => projectStaticPublication({ ...input(), apps: { apps: { analytics: { enabled: true } } } }, identity), /Core modules/);
  const value = input(); value.pages[0].content_mode = 'blocks';
  assert.throws(() => projectStaticPublication(value, identity), /HTML/);
});

test('projects nested public settings and permits publication after the last page is removed', () => {
  const value = input(); value.pages = [];
  value.settings.contact = { email: 'public@example.invalid', address: { address_locality: 'Example town', internal: 'private-value' }, billing_email: 'private-value' };
  value.settings.social = { linkedin: 'https://example.invalid/profile', internal: 'private-value' };
  value.settings.organization = { name: 'Public company', same_as: ['https://example.invalid/profile'], internal: 'private-value' };
  value.settings.cookie_consent = { enabled: true, text: 'Public consent', scripts_optional: '<script>window.example=true</script>', internal: 'private-value' };
  const publication = projectStaticPublication(value, identity);
  assert.deepEqual(publication.pages, []);
  assert.deepEqual(publication.settings.contact, { email: 'public@example.invalid', address: { address_locality: 'Example town' } });
  assert.equal(publication.settings.cookie_consent.scripts_optional, '<script>window.example=true</script>');
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  assert.match(publication.publication_id, /^[a-f0-9]{64}$/);
});

test('publishes Google font delivery only when chosen, so self-hosting is the default', () => {
  const value = input();
  value.settings.fonts.delivery = 'google';
  assert.equal(projectStaticPublication(value, identity).settings.fonts.delivery, 'google');
  for (const other of ['self_hosted', 'cdn', undefined]) {
    value.settings.fonts.delivery = other;
    assert.equal(projectStaticPublication(value, identity).settings.fonts.delivery, undefined);
  }
});
test('publishes font roles, extra weights and font services, and rejects invalid ones', () => {
  const value = input();
  Object.assign(value.settings.fonts, { display: 'Fraunces', accent: 'Space Grotesk',
    load: { heading: { weights: [800], italic: [700] } },
    services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'], token: 'private-value' }, { provider: 'bunny', url: 'https://fonts.bunny.net/css?family=inter:400', families: ['Inter'] }] });
  const fonts = projectStaticPublication(value, identity).settings.fonts;
  assert.deepEqual(fonts, { heading: 'system-ui', body: 'system-ui', display: 'Fraunces', accent: 'Space Grotesk', size_base: 16,
    load: { heading: { weights: [800], italic: [700] } },
    services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'] }, { provider: 'bunny', url: 'https://fonts.bunny.net/css?family=inter:400', families: ['Inter'] }] });
  for (const invalid of [
    { load: { title: { weights: [400] } } }, { load: { body: { weights: [450] } } }, { load: { body: { sizes: [400] } } },
    { services: [{ provider: 'bunny', url: 'https://evil.example/css', families: ['Inter'] }] },
    { services: [{ provider: 'fontshare', url: 'http://api.fontshare.com/v2/css?f[]=satoshi', families: ['Satoshi'] }] },
    { services: [{ provider: 'adobe', kit: 'ABC', families: ['x'] }] },
    { services: [{ provider: 'adobe', kit: 'abc1234', families: ['</style>'] }] },
  ]) {
    const next = input(); Object.assign(next.settings.fonts, invalid);
    assert.throws(() => projectStaticPublication(next, identity), /fonts\.(load|services)/, JSON.stringify(invalid));
  }
});
test('publishes the font smoothing setting and drops unknown values', () => {
  const value = input();
  value.settings.fonts.smoothing = 'antialiased';
  assert.equal(projectStaticPublication(value, identity).settings.fonts.smoothing, 'antialiased');
  value.settings.fonts.smoothing = 'subpixel';
  assert.equal(projectStaticPublication(value, identity).settings.fonts.smoothing, undefined);
});

test('publishes block part styles: style part targets, instance part_styles and site block type parts', () => {
  const value = input();
  value.settings.styles = [{ id: 'quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none', opacity: 0.9, shadow: 'none', gap: '1rem' }, parts: ['core/rich_heading.link', 'promo.label'], editor: 'private-value' }];
  value.blockTypes = [{ id: 'promo', name: 'promo', label: 'Promo', container: false, template: '<div data-block="promo"><p class="promo-label">{{label}}</p></div>',
    schema: [{ name: 'label', type: 'text' }, { name: 'part_styles', type: 'part_styles' }],
    parts: [{ name: 'label', label: 'Label', selector: '.promo-label', target: 'text', decorative: false, note: 'private-value' }] }];
  value.pages[0] = { ...value.pages[0], content_mode: 'blocks', blocks: [
    { id: 'promo-one', type: 'promo', data: { label: 'New', part_styles: { label: 'quiet-link' } } },
    { id: 'rich-one', type: 'core/rich_heading', data: { html: '<a href="/x/">X</a>', part_styles: { link: 'quiet-link' } } },
  ] };
  delete value.pages[0].html_content;
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: [...coreBlockTypes, { id: 'core/rich_heading', schema: [{ name: 'html', type: 'richtext' }, { name: 'part_styles', type: 'part_styles' }] }] });
  const [style] = publication.settings.styles;
  assert.deepEqual(style.parts, ['core/rich_heading.link', 'promo.label']);
  assert.deepEqual(style.base, { decoration: 'none', opacity: 0.9, shadow: 'none', gap: '1rem' });
  assert.deepEqual(publication.pages[0].blocks.map(block => block.data.part_styles), [{ label: 'quiet-link' }, { link: 'quiet-link' }]);
  assert.deepEqual(publication.blockTypes[0].parts, [{ name: 'label', label: 'Label', selector: '.promo-label', target: 'text', decorative: false }]);
  assert.ok(!JSON.stringify(publication).includes('private-value'));
});

test('publishes explicit text colours on theme colours and drops invalid ones', () => {
  const value = input();
  value.settings.colors.on_secondary = '#ffffff';
  value.settings.colors.on_accent = 'red;}</style>';
  const colors = projectStaticPublication(value, identity).settings.colors;
  assert.equal(colors.on_secondary, '#ffffff');
  assert.equal(colors.on_accent, undefined);
  assert.equal(colors.on_primary, undefined);
});

// Every SiteSettings field, read from the type itself, and whether a
// publication carries it. A new setting fails here until someone decides:
// add it to FULL_SETTINGS (and to the projection), or list it as unpublished
// with the reason. Without this, a setting can be stored and previewed and
// never reach a published page (fonts.smoothing nearly did).
const NOT_PUBLISHED = {
  agent_instructions: 'guidance for agents, read live through the API; never rendered',
  extension_public_config: 'resolved into each Extension installation\'s public config (extensions/version-config.ts), which the publication carries in its runtime snapshot',
  font_plan: 'computed from the frozen content when the publication is frozen (publishing/theme-font-freeze.ts), never projected from stored settings',
  handover: 'the portal\'s checklist, start page and structure lock for the people who edit the site; never rendered',
};
const FULL_SETTINGS = {
  site_name: 'Site', tagline: 'Tagline', logo: '/logo.png', favicon: '/favicon.ico', apple_touch_icon: '/apple.png', icon_192: '/icon-192.png',
  responsive_breakpoints: { tablet: 600, laptop: 1000, desktop: 1300, wide: 1600 },
  trailing_slash: 'never', iframe_allowed_hosts: ['www.youtube.com'],
  colors: { primary: '#111111', secondary: '#222222', accent: '#333333', background: '#ffffff', surface: '#eeeeee', surface_hover:'#dddddd', text: '#000000', text_light: '#555555', on_primary: '#ffffff', on_secondary: '#fff', on_accent: '#111827' },
  typography: {ratio_mobile:1.2,ratio_desktop:1.25,rhythm:1.1,line_length:70},
  design_scales: { type_size:{xl:'1.5rem'}, space:{md:'1rem'}, leading:{normal:'1.5'} },
  fonts: { heading: 'Inter', body: 'Inter', mono:'Roboto Mono', display: 'Fraunces', accent: 'proxima-nova', size_base: 17, smoothing: 'antialiased', delivery: 'google',
    load: { body: { weights: [300], italic: [400] } }, services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'] }] },
  contact: { email: 'hello@example.invalid', phone: '+46 0', address: 'Street 1' },
  social: { facebook: 'https://example.invalid/f', instagram: 'https://example.invalid/i', linkedin: 'https://example.invalid/l', x: 'https://example.invalid/x', youtube: 'https://example.invalid/y' },
  scripts_head: '<meta name="a">', scripts_body_end: '<meta name="b">', custom_css: 'body{}', render_version: 6,
  styles: [], language: 'sv',
  cookie_consent: {
    enabled: true, text: 'Consent', privacy_policy_url: '/privacy', scripts_necessary: '<meta name="n">', scripts_optional: '<meta name="o">', reload_after_consent: true, manage_button: 'none',
    labels: { title: 'Cookies', reject: 'Reject', necessary: 'Necessary', accept_all: 'All', privacy_link: 'Privacy', manage: 'Manage', manage_button: 'Settings', footer_link: 'Cookie settings' },
  }, twitter_handle: '@site',
  default_seo_suffix: ' | Site', default_meta_description: 'Description', image_sizes_default: '100vw', default_og_image: '/og.png',
  organization: { name: 'Org', logo: '/org.png', same_as: ['https://example.invalid/org'] },
  robots_txt: 'User-agent: *', ai_crawler_policy: 'no_training', header_behavior: 'reveal_on_scroll_up', date_format: 'long', time_zone: 'Europe/Oslo', motion: 'reduced', content_widths: { narrow: 640, normal: 1120, wide: 1360 }, sitewide_noindex: true, sitewide_nofollow: true,
  external_routes: [{ path: '/app', owner: 'Separate deployment' }],
  seo_review: { forbidden_markers: ['TODO'], claims: [{ phrase: 'best', guidance: 'Check' }], notes: ['Note'] },
  language_sections: [{ language: 'en', home_path: '/en/', tagline: 'English', default_meta_description: 'In English',
    cookie_consent: { text: 'Cookies', privacy_policy_url: '/en/privacy/', labels: { title: 'Cookies' } } }],
};

function siteSettingsFields() {
  const source = readFileSync(new URL('../packages/shared/src/types.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export interface SiteSettings {'));
  const lines = body.slice(0, body.indexOf('\n}\n')).split('\n');
  const fields = [];
  let parent = null;
  for (const line of lines) {
    const top = line.match(/^ {2}([a-z0-9_]+)\??:\s*(\{)?/);
    if (top) { fields.push(top[1]); parent = top[2] ? top[1] : null; continue; }
    const nested = parent && line.match(/^ {4}([a-z0-9_]+)\??:/);
    if (nested) fields.push(`${parent}.${nested[1]}`);
  }
  return fields;
}

test('every SiteSettings field is published or deliberately left out', () => {
  const fields = siteSettingsFields();
  assert.ok(fields.length > 30, 'the SiteSettings parser found the fields');
  const value = input(); value.settings = structuredClone(FULL_SETTINGS);
  const published = projectStaticPublication(value, identity).settings;
  const at = (object, path) => path.split('.').reduce((node, key) => node?.[key], object);
  const unaccounted = fields.filter(field => !NOT_PUBLISHED[field] && at(FULL_SETTINGS, field) === undefined);
  assert.deepEqual(unaccounted, [], 'add these fields to FULL_SETTINGS, or to NOT_PUBLISHED with a reason');
  const dropped = fields.filter(field => !NOT_PUBLISHED[field] && at(published, field) === undefined);
  assert.deepEqual(dropped, [], 'the publication drops these fields; project them or list them in NOT_PUBLISHED');
});

function interfaceFields(name) {
  const source = readFileSync(new URL('../packages/shared/src/types.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf(`export interface ${name} {`));
  return [...body.slice(0, body.indexOf('\n}\n')).matchAll(/^ {2}([a-z0-9_]+)\??:/gm)].map(match => match[1]);
}

test('every cookie banner setting and label is published', () => {
  // SiteSettings refers to these by type name, so the field parser above does not reach them.
  const value = input(); value.settings = structuredClone(FULL_SETTINGS);
  const published = projectStaticPublication(value, identity).settings.cookie_consent;
  for (const [name, source, output] of [['CookieConsentSettings', FULL_SETTINGS.cookie_consent, published], ['CookieConsentLabels', FULL_SETTINGS.cookie_consent.labels, published.labels]]) {
    const fields = interfaceFields(name);
    assert.ok(fields.length >= 6, `the parser found the ${name} fields`);
    assert.deepEqual(fields.filter(field => source[field] === undefined), [], `add these ${name} fields to FULL_SETTINGS`);
    assert.deepEqual(fields.filter(field => output?.[field] === undefined), [], `the publication drops these ${name} fields`);
  }
});

test('publication keeps a valid cookie reopen button choice and rejects others', () => {
  const value = input();
  for (const choice of ['footer', 'floating', 'none']) {
    value.settings.cookie_consent = { enabled: true, manage_button: choice };
    assert.equal(projectStaticPublication(value, identity).settings.cookie_consent.manage_button, choice);
  }
  value.settings.cookie_consent = { enabled: true, labels: { footer_link: 'Kakinställningar' } };
  assert.equal(projectStaticPublication(value, identity).settings.cookie_consent.labels.footer_link, 'Kakinställningar');
  value.settings.cookie_consent.manage_button = 'sticky';
  assert.throws(() => projectStaticPublication(value, identity), /cookie_consent\.manage_button/);
});

test('publication rejects unsafe document paths and expiring credential-bearing media URLs', () => {
  const value = input(); value.pages[0].id = '../outside';
  assert.throws(() => projectStaticPublication(value, identity), /document ID/);
  const media = input();
  media.media[0].variants[0].cdn_url += '?X-Amz-Signature=not-permanent';
  assert.throws(() => projectStaticPublication(media, identity), /permanent HTTPS/);
});

test('generated projects contain real renderer source, no Firebase dependency and an enforceable file manifest', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-publication-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const destination = path.join(tmp, 'site');
  await createStaticPublicationProject(projectStaticPublication(input(), identity), destination);
  const template = JSON.parse(await fs.readFile(path.join(destination, 'packages/site-template/package.json'), 'utf8'));
  assert.equal(template.dependencies['firebase-admin'], undefined);
  const store = await fs.readFile(path.join(destination, 'packages/site-template/src/lib/datastore.ts'), 'utf8');
  assert.ok(!store.includes('firebase-admin'));
  assert.ok(store.includes('frozen publication fixture directory'));
  await assert.rejects(sealPublicationProject(destination), /dependency lock/);
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  const sealed = await sealPublicationProject(destination);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'publication-manifest.json'), 'utf8'));
  assert.ok(manifest.files['packages/site-template/src/pages/[...slug].astro']);
  assert.ok(manifest.files['scripts/source/bundle-blocks.ts']);
  assert.ok(manifest.files['scripts/source/search-index.ts']);
  assert.ok(manifest.files['publication.json']);
  assert.equal(sealed.files, Object.keys(manifest.files).length);
  await assert.rejects(createStaticPublicationProject(projectStaticPublication(input(), identity), destination), { code: 'EEXIST' });
});

test('generated renderer builds with no HOME and an unusable package-manager shim', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-build-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const destination = path.join(tmp, 'site');
  const publication = projectStaticPublication(input(), identity);
  publication.settings.favicon = publication.media[0].cdn_url;
  publication.media_manifest = { entries: [{ cdn_url: publication.settings.favicon, public_path: '/media/site-icon.png' }] };
  publication.pages.push({ id: 'about', slug: 'about', title: 'About', status: 'published', content_mode: 'html', html_content: '<h1 id="team">Team</h1>' });
  publication.pages[0].html_content += '<a href="https://before.example/about#team">Retargeted</a>';
  publication.reference_mapping = { format: 1, media: [], website_origins: ['https://before.example'] };
  publication.previous_website_hosts = ['old.sites.example.com'];
  await createStaticPublicationProject(publication, destination);
  // Reuse the test environment's installed dependencies without a network install.
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(destination);
  const shims = path.join(tmp, 'shims');
  const { default: sharp } = await import('sharp');
  const realDestination = await fs.realpath(destination);
  const iconSource = path.join(realDestination, '.publication-media/site-icon.png');
  await fs.mkdir(path.dirname(iconSource), { recursive: true });
  await fs.writeFile(iconSource, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff00ff' } }).png().toBuffer());
  const preparedPath = path.join(realDestination, 'prepared-media.json');
  await fs.writeFile(preparedPath, JSON.stringify({ publication_id: publication.publication_id, media: publication.media, files: [{ path: '/media/site-icon.png', source: iconSource }] }));
  await fs.mkdir(shims);
  await fs.writeFile(path.join(shims, 'npm'), '#!/bin/sh\necho "Package-manager shim must not run" >&2\nexit 93\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: destination, env: { PATH: shims, TYPEROLL_BUILD_MEDIA_PREPARED: preparedPath }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
  assert.match(html, /<h1>Public<\/h1>/);
  assert.ok(html.includes(`${new URL(publication.site_url).origin}/about#team`));
  assert.ok(!html.includes('https://before.example'));
  assert.match(html, /href="\/_assets\/icons\/favicon-[a-f0-9]+\.ico"/);
  assert.ok(html.includes('rel="manifest"'));
  const favicon = await fs.readFile(path.join(destination, 'dist/favicon.ico'));
  assert.equal(favicon.readUInt16LE(2), 1);
  assert.equal(favicon.readUInt16LE(4), 3);
  const icon32Offset = favicon.readUInt32LE(34);
  const icon32Size = favicon.readUInt32LE(30);
  const pixel = await sharp(favicon.subarray(icon32Offset, icon32Offset + icon32Size)).resize(1, 1).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [255, 0, 255]);
  const marker = JSON.parse(await fs.readFile(path.join(destination, 'dist/.well-known/typeroll/publication.json'), 'utf8'));
  assert.deepEqual(marker.paths.sort(), ['/', '/about/']);
  assert.match(await fs.readFile(path.join(destination, 'dist/_headers'), 'utf8'), new RegExp('X-Typeroll-Publication: ' + marker.id));
  const headers = await fs.readFile(path.join(destination, 'dist/_headers'), 'utf8');
  assert.ok(headers.includes('https://old.sites.example.com/*\n  X-Robots-Tag: noindex, nofollow'));
  assert.ok(!headers.includes('https://example.invalid/*\n  X-Robots-Tag: noindex, nofollow'));
  assert.ok(!result.stderr.includes('Package-manager shim must not run'));
});

test('real Core blocks build portable assets and last-page removal produces an empty publication marker', async (t) => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-blocks-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const value = input();
  value.pages[0] = { ...value.pages[0], content_mode: 'blocks', blocks: [{
    id: 'public-section', type: 'core/section', data: { width: 'normal', padding_y: 'md' }, children: [{
      id: 'public-heading', type: 'core/heading', data: { text: 'Portable real Core blocks', level: 'h1', align: 'left', size: 'auto', editor_note: 'private-value' },
    }, {
      id: 'linked-heading', type: 'core/rich_heading', data: { level: 'h2', html: '<a href="/">Home</a>', part_styles: { link: 'loud-link' } },
    }],
  }] };
  // Block part styles: a site-wide style for a part and an instance choice.
  value.settings.styles = [
    { id: 'quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none' }, parts: ['core/rich_heading.link'] },
    { id: 'loud-link', name: 'Loud link', targets: ['link'], base: { weight: 700 } },
  ];
  for (const [name, pages] of [['blocks', value.pages], ['branch', value.pages], ['empty', []]]) {
    const destination = path.join(tmp, name);
    const publication = projectStaticPublication({ ...value, pages }, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES, versionId: name === 'branch' ? 'design' : 'main', noindex: name !== 'branch' });
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const marker = JSON.parse(await fs.readFile(path.join(destination, 'dist/.well-known/typeroll/publication.json'), 'utf8'));
    const headers = await fs.readFile(path.join(destination, 'dist/_headers'), 'utf8');
    assert.match(headers, /X-Robots-Tag: noindex, nofollow/);
    const patterns = headers.split('\n').filter(line => line && !/^\s|#/.test(line));
    assert.equal(patterns.filter(line => line === '/*').length, 1, 'Cloudflare keeps only the last rule for duplicate patterns');
    assert.ok(patterns.every(line => (line.match(/\*/g) ?? []).length <= 1), 'Cloudflare permits only one wildcard per header rule');
    assert.ok(patterns.includes('https://:project.pages.dev/*'));
    assert.ok(patterns.includes('https://:version.:project.pages.dev/*'));
    assert.equal(marker.id, publication.publication_id);
    if (name !== 'empty') {
      const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
      assert.match(html, /<h1[^>]*>Portable real Core blocks<\/h1>/);
      assert.match(html, /\[data-block="heading"\]/);
      assert.match(html, /\[data-block="section"\]/);
      assert.match(html, /<h2 data-block="rich_heading"[^>]* data-part-link="loud-link"/);
      assert.ok(html.includes(':where([data-block="rich_heading"]:not([data-part-link]) a)'), 'site-wide part style');
      assert.ok(html.includes(':where([data-block="rich_heading"][data-part-link="loud-link"] a)'), 'instance part style');
      assert.ok(!html.includes('private-value'));
      assert.deepEqual(marker.paths, ['/']);
      const expectedVersion = name === 'branch' ? 'design' : 'main';
      assert.equal(publication.version_id, expectedVersion);
      assert.equal(publication.git_branch, name === 'branch' ? 'version-design' : 'main');
      const frozen = JSON.parse(await fs.readFile(path.join(destination, `.publication-work/fixtures/organizations/default/sites/default/versions/${expectedVersion}/pages/home.json`), 'utf8'));
      assert.equal(frozen.blocks[0].children[0].data.text, 'Portable real Core blocks');
    } else {
      await assert.rejects(fs.readFile(path.join(destination, 'dist/index.html')), { code: 'ENOENT' });
      assert.deepEqual(marker.paths, ['/.well-known/typeroll/publication.json']);
    }
  }
});


test('menus are projected with known fields only, sorted, and unsafe addresses are refused', () => {
  const value = input();
  value.menus = [
    { id: 'footer', name: 'Footer', locations: ['footer'], items: [], created_at: '2026-01-01T00:00:00Z', editor: 'private-value' },
    { id: 'main', name: 'Main', locations: ['primary'], auto_add_pages: true, updated_at: '2026-01-02T00:00:00Z', items: [
      { id: 'home', type: 'page', page_id: 'home', label: 'Start', note: 'private-value', children: [
        { id: 'blog', type: 'url', href: 'https://blog.example.invalid/', label: 'Blog', description: 'News', link_rel: 'nofollow', children: [] },
      ] },
    ] },
  ];
  const publication = projectStaticPublication(value, identity);
  assert.deepEqual(publication.menus, [
    { id: 'footer', name: 'Footer', locations: ['footer'], items: [] },
    { id: 'main', name: 'Main', locations: ['primary'], auto_add_pages: true, items: [
      { id: 'home', type: 'page', page_id: 'home', label: 'Start', children: [
        { id: 'blog', type: 'url', href: 'https://blog.example.invalid/', label: 'Blog', description: 'News', link_rel: 'nofollow' },
      ] },
    ] },
  ]);
  assert.deepEqual(projectStaticPublication(input(), identity).menus, []);
  for (const menus of [
    [{ id: 'main', name: 'Main', items: [{ id: 'x', type: 'url', href: 'javascript:alert(1)', label: 'X' }] }],
    [{ id: 'main', name: 'Main', items: [{ id: 'x', type: 'script', label: 'X' }] }],
    [{ id: 'Main!', name: 'Main', items: [] }],
    [{ id: 'main', name: 'Main', items: [{ id: 'a', type: 'heading', label: 'A', children: [{ id: 'b', type: 'heading', label: 'B', children: [{ id: 'c', type: 'heading', label: 'C', children: [{ id: 'd', type: 'url', href: '/', label: 'D' }] }] }] }] }],
    [{ id: 'main', name: 'Main', items: [] }, { id: 'main', name: 'Again', items: [] }],
  ]) assert.throws(() => projectStaticPublication({ ...input(), menus }, identity), /menu|Duplicate/);
});

test('a frozen render version 15 project shows the primary menu with its submenu on every page', async (t) => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-menus-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const value = input();
  value.settings.render_version = 15;
  const page = (id, slug, title, extra = {}) => ({ id, slug, title, status: 'published', content_mode: 'blocks', blocks: [{ id: `${id}-text`, type: 'core/prose', data: { html: `<p>${title}</p>` } }], ...extra });
  value.pages = [page('home', '', 'Home'), page('services', 'services', 'Services'), page('design', 'design', 'Design & build', { parent: 'services', path: '/services/design' })];
  value.partials = [{ id: 'header', name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [
    { id: 'nav', type: 'core/navigation_links', data: { source: 'menu', menu: 'location:primary', direction: 'row' } },
  ] }];
  value.menus = [{ id: 'main', name: 'Main', locations: ['primary'], items: [
    { id: 'home', type: 'page', page_id: 'home' },
    { id: 'services', type: 'page', page_id: 'services', children: [{ id: 'design', type: 'page', page_id: 'design', description: 'Houses <and> schools' }] },
  ] }];
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES });
  const destination = path.join(tmp, 'site');
  await createStaticPublicationProject(publication, destination);
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(destination);
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const home = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
  assert.match(home, /<a href="\/" aria-current="page">Home<\/a>/);
  assert.match(home, /<li class="block-nav-parent" data-submenu="dropdown"><a href="\/services\/">Services<\/a><button type="button" class="block-nav-toggle" aria-expanded="false" aria-controls="nav-nav-services">/);
  assert.match(home, /Houses &lt;and&gt; schools/);
  assert.match(home, /register\('core\/navigation_links'/);
  // The header is rendered per route: the current page and its parent differ.
  const design = await fs.readFile(path.join(destination, 'dist/services/design/index.html'), 'utf8');
  assert.match(design, /<li class="block-nav-parent block-nav-parent--current" data-submenu="dropdown">/);
  assert.match(design, /<a href="\/services\/design\/" aria-current="page">/);
  assert.doesNotMatch(design, /<a href="\/" aria-current="page">/);
});

test('site fields travel as values of public fields with the definitions of their formats', () => {
  const value = input();
  value.siteFields = {
    updated_at: '2026-11-07T00:00:00Z',
    groups: [{ id: 'contact', label: 'Contact', access: 'admin', description: 'private-value', fields: [
      { name: 'phone', type: 'text', label: 'Phone', help: 'private-value' },
      { name: 'season', type: 'select', label: 'Season', options: ['summer', 'winter'], option_labels: ['Summer', 'Winter'] },
      { name: 'note', type: 'text', label: 'Note', rendered: false },
      { name: 'logo', type: 'image', label: 'Logo' },
      { name: 'opening_hours', type: 'object', label: 'Hours', presentation: 'opening_hours', fields: [
        { name: 'days', type: 'array', label: 'Week', fields: [{ name: 'day', type: 'select', label: 'Day', options: ['monday'] }, { name: 'opens', type: 'text', label: 'Opens' }, { name: 'secret', type: 'text', label: 'S', rendered: false }] },
      ] },
    ] }],
    values: { phone: '090-12 34 56', season: 'winter', note: 'private-value', removed: 'private-value', logo: 'https://media.example.invalid/private.png',
      opening_hours: { days: [{ day: 'monday', opens: '09:00', secret: 'private-value' }] } },
  };
  const publication = projectStaticPublication(value, identity);
  assert.deepEqual(publication.siteFields, {
    groups: [{ id: 'contact', fields: [
      { name: 'phone', type: 'text' },
      { name: 'season', type: 'select', options: ['summer', 'winter'], option_labels: ['Summer', 'Winter'] },
      { name: 'logo', type: 'image' },
      { name: 'opening_hours', type: 'object', presentation: 'opening_hours', fields: [
        { name: 'days', type: 'array', fields: [{ name: 'day', type: 'select', options: ['monday'] }, { name: 'opens', type: 'text' }] },
      ] },
    ] }],
    values: { phone: '090-12 34 56', season: 'winter', logo: 'https://media.example.invalid/private.png', opening_hours: { days: [{ day: 'monday', opens: '09:00' }] } },
  });
  assert.doesNotMatch(JSON.stringify(publication.siteFields), /private-value/);
  // A site field image is published media.
  assert.ok(publication.media.some(item => item.id === 'unused'));
  // A site without site fields publishes exactly as before.
  assert.equal('siteFields' in projectStaticPublication(input(), identity), false);
  assert.equal('siteFields' in projectStaticPublication({ ...input(), siteFields: { groups: [], values: {} } }, identity), false);
  for (const siteFields of [[], { groups: {} }, { groups: [{ id: 'Bad!', fields: [] }] }, { groups: [{ id: 'a', fields: [{ name: 'x', type: 'script' }] }] }, { groups: [], values: [] }]) {
    assert.throws(() => projectStaticPublication({ ...input(), siteFields }, identity), /site field/);
  }
});

test('site field values are not a render-cache global, but a domain rebase needs them unchanged', () => {
  const value = input();
  value.siteFields = { groups: [{ id: 'contact', label: 'Contact', fields: [{ name: 'phone', type: 'text', label: 'Phone' }] }], values: { phone: '1' } };
  const before = createRenderPlan(projectStaticPublication(value, identity), { files: {} });
  value.siteFields.values.phone = '2';
  const after = createRenderPlan(projectStaticPublication(value, identity), { files: {} });
  assert.equal(after.globalKey, before.globalKey);
  assert.notEqual(after.domainKey, before.domainKey);
});

test('a frozen project shows site fields, conditions, opening hours and live snippets that refresh in the browser', async (t) => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-site-fields-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const value = input();
  value.settings.render_version = 15;
  value.settings.language = 'sv';
  const week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day, index) => index < 5 ? { day, opens: '09:00', closes: '17:00' } : { day, closed: true });
  value.siteFields = { groups: [{ id: 'contact', label: 'Contact', fields: [
    { name: 'phone', type: 'text', label: 'Phone', live: true }, { name: 'show_booking', type: 'boolean', label: 'Booking' },
    { name: 'opening_hours', type: 'object', label: 'Hours', presentation: 'opening_hours', fields: [
      { name: 'days', type: 'array', label: 'Week', fields: [{ name: 'day', type: 'select', label: 'Day', options: week.map(entry => entry.day) }, { name: 'closed', type: 'boolean', label: 'Closed' }, { name: 'opens', type: 'text', label: 'Opens' }, { name: 'closes', type: 'text', label: 'Closes' }] },
      { name: 'exceptions', type: 'array', label: 'Exceptions', fields: [{ name: 'date', type: 'date', label: 'Date' }, { name: 'closed', type: 'boolean', label: 'Closed' }, { name: 'note', type: 'text', label: 'Note' }] },
    ] },
  ] }], values: { phone: '090-12 34 56 <b>', show_booking: true, opening_hours: { days: week, exceptions: [{ date: '2026-11-10', closed: true, note: 'Personaldag' }] } } };
  value.pages = [{ id: 'home', slug: '', title: 'Home', status: 'published', content_mode: 'blocks', blocks: [
    { id: 'phone', type: 'core/site_field', data: { field: 'phone', label: 'Telefon' } },
    { id: 'show', type: 'core/show_if', data: { condition: 'site.fields.show_booking' }, children: [{ id: 'book', type: 'core/prose', data: { html: '<p>Boka ett besök</p>' } }] },
    { id: 'hide', type: 'core/show_if', data: { condition: '!site.fields.show_booking' }, children: [{ id: 'nobook', type: 'core/prose', data: { html: '<p>Ingen bokning</p>' } }] },
    { id: 'now', type: 'core/site_field', data: { field: 'opening_hours', format: 'open_now' } },
    { id: 'lunch', type: 'core/snippet', data: { snippet: 'lunch', tag: 'section' } },
  ] }, { id: 'about', slug: 'about', title: 'About', status: 'published', content_mode: 'blocks', blocks: [{ id: 'about-text', type: 'core/prose', data: { html: '<p>About</p>' } }] }];
  value.partials = [{ id: 'footer', name: 'Footer', kind: 'footer', status: 'published', content_mode: 'blocks', blocks: [
    { id: 'week', type: 'core/site_field', data: { field: 'opening_hours', label: 'Öppettider' } },
  ] }];
  // A dated snippet: Monday's lunch, a date that wins over its weekday, and who wrote it (never published).
  value.snippets = [{ id: 'lunch', name: 'Lunch', kind: 'dated', format: 'html', updated_by: 'user:ada', updated_at: '2026-11-08T08:00:00.000Z',
    entries: [{ weekday: 'monday', content: '<p>Fiskgratäng</p>' }, { weekday: 'tuesday', content: '<p>Pytt i panna</p>' }, { date: '2026-11-11', content: '<p>Ärtsoppa</p>' }], fallback: '<p>Ingen lunch</p>' }];
  value.liveBaseUrl = 'https://media.example.invalid/live/';
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES });
  assert.deepEqual(publication.snippets, [{ id: 'lunch', kind: 'dated', format: 'html', updated_at: '2026-11-08T08:00:00.000Z',
    entries: [{ weekday: 'monday', content: '<p>Fiskgratäng</p>' }, { weekday: 'tuesday', content: '<p>Pytt i panna</p>' }, { date: '2026-11-11', content: '<p>Ärtsoppa</p>' }], fallback: '<p>Ingen lunch</p>' }]);
  assert.equal(publication.site.live_base_url, 'https://media.example.invalid/live');
  assert.doesNotMatch(JSON.stringify(publication), /user:ada/);
  assert.throws(() => projectStaticPublication({ ...value, liveBaseUrl: 'http://media.example.invalid/live' }, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES }), /HTTPS/);
  const destination = path.join(tmp, 'site');
  await createStaticPublicationProject(publication, destination);
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(destination);
  // Monday 2026-11-09, 11:30 in Stockholm.
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: { TYPEROLL_BUILD_TIME: '2026-11-09T10:30:00Z' }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const home = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
  assert.match(home, /<span class="block-site-field-label">Telefon<\/span> <span class="block-site-field-value">090-12 34 56 &lt;b&gt;<\/span>/);
  assert.match(home, /Boka ett besök/);
  assert.doesNotMatch(home, /Ingen bokning/);
  assert.match(home, /data-site-field-clock="[^"]+">Öppet nu, till 17:00<\/span>/);
  // An exception's note shows in bold under its weekday.
  assert.match(home, /<tr data-day="monday" data-today="true" aria-current="date"><th>Måndag<\/th><td>09:00–17:00<\/td><\/tr><tr data-day="tuesday" data-exception="true"><th>Tisdag<br ?\/?><strong class="block-site-field-note">Personaldag<\/strong><\/th><td>Stängt<\/td><\/tr>/);
  assert.match(home, /core\/site_field opening hours/);
  // A live site field names the live fields file; the page ships the script that reads it.
  assert.match(home, /data-site-field="phone" data-site-field-src="https:\/\/media\.example\.invalid\/live\/_fields\.json"/);
  assert.match(home, /core\/site_field live values/);
  // The snippet shows Monday's entry as of the build and names its live file.
  assert.match(home, /<section data-block="snippet" data-snippet="lunch" data-format="html" data-snippet-src="https:\/\/media\.example\.invalid\/live\/lunch\.json" data-updated="2026-11-08T08:00:00.000Z" data-snippet-date="2026-11-09"[^>]*><p>Fiskgratäng<\/p><\/section>/);
  assert.match(home, /core\/snippet live content/);
  // The footer's week ships the refresh script on a page without other site fields too.
  const about = await fs.readFile(path.join(destination, 'dist/about/index.html'), 'utf8');
  assert.match(about, /<caption class="block-site-field-label">Öppettider<\/caption>/);
  assert.match(about, /core\/site_field opening hours/);
  // A page without a live block ships no live script.
  assert.doesNotMatch(about, /core\/snippet live content|core\/site_field live values/);
});

test('a resolved branch cannot accidentally publish its frozen source as main', () => {
  const value = { ...input(), versionId: 'design' };
  const publication = projectStaticPublication(value, { ...identity, noindex: false });
  assert.equal(publication.version_id, 'design');
  assert.equal(publication.git_branch, 'version-design');
  assert.equal(publication.settings.sitewide_noindex, true);
  assert.notEqual(publication.publication_id, projectStaticPublication(input(), identity).publication_id);
  assert.throws(() => projectStaticPublication(value, { ...identity, versionId: 'main' }), /version mismatch/);
});


test('generated branch names accept version suffixes without allowing arbitrary Git refs', () => {
  const versionId = 'a'.repeat(48) + '-2';
  const publication = projectStaticPublication({ ...input(), versionId }, identity);
  // Long names fit Cloudflare's 28-character branch alias: a prefix and a hash of the full name.
  assert.match(publication.git_branch, /^version-a{13}-[a-f0-9]{6}$/);
  assert.equal(projectStaticPublication({ ...input(), versionId: 'qa-2' }, identity).git_branch, 'version-qa-2');
  for (const invalid of ['../main', 'refs/heads/main', 'Design', 'a'.repeat(129)]) {
    assert.throws(() => projectStaticPublication({ ...input(), versionId: invalid }, identity), /version ID/);
  }
});

test('frozen main and branch projects render their own custom blocks and inherited page templates', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-template-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  for (const versionId of ['main', 'design']) {
    const value = input();
    value.versionId = versionId;
    value.redirects = [
      { id: 'old', from_path: '/old', to_path: `/${versionId}`, status_code: 301, internal: 'private-value' },
      { id: 'legacy.html', from_path: '/legacy.html', to_path: `/${versionId}`, status_code: 301 },
      { id: '_archive___splat', from_path: '/_archive/*', to_path: '/news/:splat', status_code: 302 },
      { id: 'shadow', from_path: '/', to_path: '/missing', status_code: 302 },
    ];
    value.pages = [{ id: 'home', slug: '', title: 'Home', status: 'published', template: 'layout', content_mode: 'blocks', blocks: [
      { id: 'heading-one', type: 'custom-heading', data: { text: versionId + ' content', private_note: 'private-value' } },
    ] }];
    value.blockTypes = [
      { id: 'custom-heading', name: 'custom-heading', label: 'Heading', container: false, template: `<h2 data-version="${versionId}">{{text}}</h2>`, styles: 'h2 { color: blue; }',
        schema: [{ name: 'text', type: 'text' }, { name: 'private_note', type: 'text', rendered: false, default: 'private-value' }], imported_from: { author: 'private-value' } },
      { id: 'custom-frame', name: 'custom-frame', label: 'Frame', container: true, template: '<article data-layout="inherited">{{children}}</article>', schema: [] },
    ];
    value.pageTemplates = [
      { id: 'layout', name: 'Layout', status: 'published', blocks: [{ id: 'frame', type: 'custom-frame', data: {}, children: [{ id: 'content-slot', type: 'template_content_slot', data: {} }] }], created_by: 'private-value' },
      { id: 'draft-layout', name: 'private-value', status: 'draft', blocks: [] },
    ];
    const publication = projectStaticPublication(value, identity);
    assert.ok(!JSON.stringify(publication).includes('private-value'));
    assert.equal(publication.blockTypes[0].schema.length, 0); // deterministic ID order: frame before heading
    const destination = path.join(tmp, versionId);
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
    assert.match(html, new RegExp(`<h2(?=[^>]*data-version="${versionId}")(?=[^>]*id="${versionId}-content")(?=[^>]*data-source-block-id="heading-one")[^>]*>${versionId} content</h2>`));
    assert.match(html, /<article[^>]*data-layout="inherited"[^>]*>/);
    assert.ok(!html.includes(versionId === 'design' ? 'main content' : 'design content'));
    assert.match(html, /h2\s*\{\s*color:\s*blue/);
    const redirects = await fs.readFile(path.join(destination, 'dist/_redirects'), 'utf8');
    assert.ok(redirects.includes(`/old /${versionId}/ 301`));
    assert.ok(redirects.includes(`/old/ /${versionId}/ 301`));
    assert.ok(redirects.includes(`/legacy.html /${versionId}/ 301`));
    assert.ok(redirects.includes('/_archive/* /news/:splat/ 302'), redirects);
    assert.ok(!redirects.includes('/missing'));
  }
});

test('portable source renders typed Pages, form runtime and language metadata while excluding private actions', async t => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-public-runtime-'));
  const tmp = path.join(directory, 'site');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const value = input();
  value.pages[0].html_content = '<h1>Public runtime</h1><x-form id="contact" />';
  value.pages[0].alternates = [{ hreflang: 'sv', href: 'https://sv.example.invalid/' }];
  // A Swedish language section: its pages keep their language and it gets its own 404 page.
  value.settings.language = 'fi';
  value.settings.language_sections = [{ language: 'sv-SE', home_path: '/sv/' }];
  value.pages.push({ id: 'sv-home', title: 'Svenska', slug: 'sv', path: '/sv', language: 'sv-SE', status: 'published', content_mode: 'html', html_content: '<h1>Svenska</h1>' });
  value.contentTypes = [{ id: 'news', name: 'news', label_singular: 'News', label_plural: 'News', route_template: '/news/{slug}', template: 'news-layout', fields: [{ name: 'summary', label: 'Summary', type: 'text' }, { name: 'internal_notes', type: 'text', rendered: false }] }];
  value.pageTemplates = [{ id: 'news-layout', name: 'news-layout', label: 'News', status: 'published', blocks: [{ id: 'title', type: 'template/page_title', data: { level: 'h1' } }, { id: 'body', type: 'template_content_slot', data: {} }] }];
  value.pages.push({ id: 'article', title: 'Frozen typed article', slug: 'article', content_type: 'news', content_mode: 'blocks', blocks: [{ id: 'copy', type: 'core/prose', data: { html: '<p>Portable article body</p>' } }], status: 'published', fields: { summary: 'Public summary', internal_notes: 'private-value' }, _provenance: { private: 'private-value' } });
  value.publicRuntime = { apps: { apps: {} }, extensions: { installations: [] }, forms: [{ id: 'contact', name: 'Contact', submit_text: 'Send request', submit_url: 'https://forms.example.invalid/submit/contact', submit_token: 'public-form-capability', pow_bits: 16, actions: [{ config: { token: 'private-value' } }], steps: [{ id: 'step-one', blocks: [{ id: 'field', type: 'form/text', data: { name: 'name', label: 'Your name' } }] }] }], dependencies: [{ kind: 'forms', id: 'contact', endpoint: 'https://forms.example.invalid/submit/contact' }] };
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES });
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  await createStaticPublicationProject(publication, tmp);
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(tmp, 'node_modules'), 'dir');
  await fs.writeFile(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(tmp);
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: tmp, env: {}, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const article = await fs.readFile(path.join(tmp, 'dist/news/article/index.html'), 'utf8');
  assert.match(article, /Frozen typed article/);
  assert.match(article, /Portable article body/);
  const home = await fs.readFile(path.join(tmp, 'dist/index.html'), 'utf8');
  assert.match(home, /hreflang="sv"/);
  assert.match(home, /forms.example.invalid/);
  assert.match(home, /Your name/);
  assert.match(home, /Send request/);
  const swedish = await fs.readFile(path.join(tmp, 'dist/sv/index.html'), 'utf8');
  assert.match(swedish, /<html lang="sv-SE"/);
  const notFound = await fs.readFile(path.join(tmp, 'dist/sv/404.html'), 'utf8');
  assert.match(notFound, /Sidan hittades inte/);
  assert.match(notFound, /href="\/sv\/"/);
  const marker = JSON.parse(await fs.readFile(path.join(tmp, 'dist/.well-known/typeroll/publication.json'), 'utf8'));
  assert.ok(marker.paths.includes('/sv/') && !marker.paths.some(route => route.endsWith('/404')), 'not-found pages are not publication routes');
});

test('publication keeps each page language', () => {
  const value = input();
  value.pages[0].language = 'sv-SE';
  assert.equal(projectStaticPublication(value, identity).pages[0].language, 'sv-SE');
  value.pages[0].language = 7;
  assert.throws(() => projectStaticPublication(value, identity), /language/);
});

test('publication rejects a language section without a path prefix', () => {
  const value = input();
  value.settings.language_sections = [{ language: 'sv', home_path: '/' }];
  assert.throws(() => projectStaticPublication(value, identity), /language_sections/);
});

test('frozen content types preserve mapped-only schema without hidden field mappings', () => {
  const value = input();
  value.contentTypes = [{ id: 'suppliers', name: 'suppliers', label_singular: 'Supplier', label_plural: 'Suppliers', route_template: '/companies/{slug}', schema_type: 'Organization', schema_field_mode: 'mapped', schema_field_map: { title: 'name', secret: 'email' }, fields: [{ name: 'secret', type: 'email', label: 'Secret', rendered: false }] }];
  const publication = projectStaticPublication(value, identity);
  const type = publication.contentTypes.find(type => type.id === 'suppliers');
  assert.equal(type.schema_field_mode, 'mapped');
  assert.deepEqual(type.schema_field_map, { title: 'name' });
});

test('frozen publication preserves declared external ownership and rejects invalid paths', () => {
  const value = input();
  value.settings.external_routes = [{ path: '/docs/', owner: 'Documentation deployment' }];
  const publication = projectStaticPublication(value, identity);
  assert.deepEqual(publication.settings.external_routes, value.settings.external_routes);
  value.settings.external_routes = [{ path: '/docs/*', owner: 'Docs' }];
  assert.throws(() => projectStaticPublication(value, identity), /external_routes/);
});

test('design tokens survive frozen publication and invalidate its identity when settings change', () => {
  const value = input(); value.settings = structuredClone(FULL_SETTINGS);
  const before = projectStaticPublication(value, identity);
  assert.deepEqual(before.settings.design_scales, FULL_SETTINGS.design_scales);
  assert.deepEqual(before.settings.typography, FULL_SETTINGS.typography);
  assert.equal(before.settings.fonts.mono,'Roboto Mono');
  assert.equal(before.settings.colors.surface_hover,'#dddddd');
  value.settings.design_scales.space.md = {mobile:'1rem',desktop:'clamp(2rem, 1rem + 2vw, 3rem)'};
  assert.notEqual(createRenderPlan(projectStaticPublication(value, identity), {files:{}}).globalKey, createRenderPlan(before, {files:{}}).globalKey);
  value.settings.design_scales.space.md = '2px;display:none';
  assert.throws(() => projectStaticPublication(value, identity), /Invalid public design_scales/);
});

test('frozen publication image sitemap groups typed Page and block images at resolved routes', async (t) => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-image-sitemap-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const value = input();
  value.contentTypes = [{ id: 'article', name: 'article', label_singular: 'Article', label_plural: 'Articles', route_template: '/tips/{slug}', fields: [
    { name: 'featured_image', type: 'image', label: 'Featured image' }, { name: 'internal_image', type: 'image', label: 'Private', rendered: false },
  ] }];
  const article = { id: 'article', content_type: 'article', slug: 'address-change', title: 'Address change', status: 'published', content_mode: 'blocks',
    fields: { featured_image: 'https://media.example.invalid/featured.jpg', internal_image: 'https://media.example.invalid/private.jpg' },
    blocks: [{ id: 'body-image', type: 'core/image', data: { src: 'https://media.example.invalid/body.jpg', alt: 'Moving boxes' } },
      { id: 'prose-image', type: 'core/prose', data: { html: '<p><img src="https://media.example.invalid/prose.jpg" alt="Address label"></p>' } }] };
  value.pages.push(article, { ...article, id: 'excluded', slug: 'excluded', noindex: true }, { ...article, id: 'unlisted', slug: 'unlisted', status: 'unlisted' },
    { ...article, id: 'nested', slug: 'simple', path: '/explicit/nested/', fields: { featured_image: 'https://media.example.invalid/nested.jpg' } });
  for (const blocked of [false, true]) {
    const destination = path.join(tmp, blocked ? 'blocked' : 'live');
    const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES, noindex: blocked });
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const xml = await fs.readFile(path.join(destination, 'dist/sitemap-images.xml'), 'utf8');
    if (blocked) { assert.ok(!xml.includes('<url>')); continue; }
    const groups = [...xml.matchAll(/<url>(.*?)<\/url>/g)].map(match => match[1]);
    assert.equal(groups.length, 3, xml);
    const target = groups.find(group => group.includes('<loc>https://example.invalid/tips/address-change/</loc>'));
    assert.ok(target, xml);
    for (const image of ['featured.jpg', 'body.jpg', 'prose.jpg']) assert.ok(target.includes(image), target);
    assert.ok(groups.some(group => group.includes('<loc>https://example.invalid/explicit/nested/</loc>')));
    assert.ok(!/private.jpg|\/excluded\/|\/unlisted\/|\/draft\//.test(xml));
  }
});
