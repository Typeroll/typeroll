// Site fields in previews, exports and publications: the preview renders the
// version's values ({{site.fields.*}}, core/site_field, core/show_if), the
// export carries the site fields document, and the publication lists blocks
// that read a field the site does not define.
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, openingHoursField, paths, SITE_FIELD_CLOCK_SCRIPT } from '@typeroll/shared';
import type { Block, Site, SiteFieldGroup, SiteVersion } from '@typeroll/shared';
import { publicationSiteFieldWarnings } from '../../lib/publishing/content-preflight';
import { captureImpact } from '../../lib/publishing/impact';

const ORG = 'orgone';
const SITE = 'fieldsite';
const GROUPS: SiteFieldGroup[] = [{ id: 'contact', label: 'Contact', fields: [
  { name: 'phone', type: 'text', label: 'Phone' },
  { name: 'show_booking', type: 'boolean', label: 'Show booking' },
  { name: 'note', type: 'text', label: 'Internal note', rendered: false },
  openingHoursField(),
] }];
const VALUES = {
  phone: '090-12 34 56', show_booking: true, note: 'private',
  opening_hours: { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => ({ day, opens: '09:00', closes: '17:00' })) },
};
const BLOCKS: Block[] = [
  { id: 'phone', type: 'core/site_field', data: { field: 'phone', label: 'Call us' } },
  { id: 'bound', type: 'core/text', data: { text: '{{site.fields.phone}}' } },
  { id: 'show', type: 'core/show_if', data: { condition: 'site.fields.show_booking' }, children: [{ id: 'book', type: 'core/prose', data: { html: '<p>Book a visit</p>' } }] },
  { id: 'hide', type: 'core/show_if', data: { condition: '!site.fields.show_booking' }, children: [{ id: 'nobook', type: 'core/prose', data: { html: '<p>No booking</p>' } }] },
  { id: 'hours', type: 'core/site_field', data: { field: 'opening_hours', label: 'Opening hours' } },
  { id: 'private', type: 'core/site_field', data: { field: 'note', empty_text: 'nothing' } },
];

describe('site fields in the preview and the export', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), { name: 'Field Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'Field Site', language: 'en', render_version: 15 });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, { title: 'Start', slug: 'home', path: '/', content_mode: 'blocks', status: 'published', blocks: BLOCKS, html_content: '' });
    await store.setDoc(paths.siteFields(ORG, SITE, MAIN_VERSION_ID), { groups: GROUPS, values: VALUES });
  });

  it('renders the version\'s values, conditions and opening hours', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { allowScripts: true }))!;
    expect(html).toContain('<span class="block-site-field-label">Call us</span> <span class="block-site-field-value">090-12 34 56</span>');
    expect(html).toMatch(/data-block="text"[^>]*>090-12 34 56</);
    expect(html).toContain('Book a visit');
    expect(html).not.toContain('No booking');
    expect(html).toContain('<caption class="block-site-field-label">Opening hours</caption>');
    expect(html).toContain('<tr data-day="monday"');
    // A private field never reaches the page.
    expect(html).not.toContain('private');
    expect(html).toContain('>nothing<');
    expect(html).toContain(SITE_FIELD_CLOCK_SCRIPT.slice(0, 40));
  });

  it('exports the site fields document with the version', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { contentSnapshot } = await import('../../lib/export');
    const snapshot = await contentSnapshot(getStore(), ORG, SITE, MAIN_VERSION_ID);
    expect(snapshot.get(paths.siteFields(ORG, SITE, MAIN_VERSION_ID))).toMatchObject({ groups: GROUPS, values: VALUES });
  });
});

describe('site fields in a publication', () => {
  it('warns once about fields the site does not define', () => {
    const publication = {
      siteFields: { groups: GROUPS },
      pages: [{ id: 'home', blocks: [...BLOCKS, { id: 'fax', type: 'core/site_field', data: { field: 'fax' } }] }],
      partials: [{ id: 'footer', kind: 'footer', blocks: [{ id: 's', type: 'core/show_if', data: { condition: 'site.fields.holiday || site.fields.fax' }, children: [] }, { id: 'e', type: 'core/site_field', data: {} }] }],
    };
    expect(publicationSiteFieldWarnings(publication)).toEqual([
      'page home reads the site field "fax", which the site does not define or keeps private; a Site field block shows nothing for it and a condition on it is false.',
      'partial footer reads the site field "holiday", which the site does not define or keeps private; a Site field block shows nothing for it and a condition on it is false.',
      'partial footer has a Site field block that names no field.',
    ]);
    expect(publicationSiteFieldWarnings({ pages: [{ id: 'home', blocks: [] }] })).toEqual([]);
  });

  it('lists site fields in the impact only when the publication has them', () => {
    const base = { pages: [], partials: [], settings: {} };
    expect(captureImpact(base, ORG, SITE).entries.some(entry => entry.id === 'siteFields')).toBe(false);
    expect(captureImpact({ ...base, siteFields: { groups: [], values: { phone: '1' } } }, ORG, SITE).entries.find(entry => entry.id === 'siteFields')).toMatchObject({ kind: 'configuration', title: 'Site fields' });
  });
});
