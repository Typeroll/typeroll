import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createSite } from '../../lib/site-create';
import { defaultFooterHtml, defaultHeaderHtml } from '../../lib/default-partials';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

const internalLinks = (html: string) => [...html.matchAll(/href="(\/[^"]*)"/g)].map(([, href]) => href);

it('seeds a new site that can be published as it is: a published home page and links only to it', async () => {
  const { siteId } = await createSite({ orgId: 'org', name: 'Fresh Site' });
  expect(await getStore().getDoc(`${paths.pages('org', siteId)}/home`)).toMatchObject({ slug: 'home', status: 'published' });
  for (const kind of ['header', 'footer']) {
    const partial = await getStore().getDoc<{ content_mode: string; blocks: unknown[]; status: string }>(paths.partial('org', siteId, kind));
    expect(partial?.status).toBe('published');
    expect(partial?.content_mode).toBe('blocks');
    // The starter navigation shows the seeded menus; it has no links of its own.
    const json = JSON.stringify(partial!.blocks);
    expect(json).toContain(`"menu":"location:${kind === 'header' ? 'primary' : 'footer'}"`);
    expect(json).not.toContain('"href"');
  }
  expect(internalLinks(defaultHeaderHtml('Fresh Site'))).toContain('/');
});

it('keeps the brand and copyright in the starter header and footer', () => {
  expect(defaultHeaderHtml('Acme & Co')).toContain('Acme &amp; Co');
  expect(defaultFooterHtml('Acme', 'Tagline')).toMatch(/Tagline[\s\S]*&copy; \d{4} Acme/);
});

it('seeds a primary menu that adds new pages and a footer menu, both linking the home page by id', async () => {
  const { siteId } = await createSite({ orgId: 'org', name: 'Menu Site' });
  const { vstore } = await import('../../lib/version-store');
  const { MAIN_VERSION_ID, validateMenu, findMenu } = await import('@typeroll/shared');
  const menus = await vstore.menus('org', siteId, MAIN_VERSION_ID);
  expect(menus.map(menu => menu.id).sort()).toEqual(['footer', 'primary']);
  for (const menu of menus) expect(validateMenu(menu).errors).toEqual([]);
  expect(findMenu(menus, 'location:primary')).toMatchObject({ id: 'primary', auto_add_pages: true, items: [{ type: 'page', page_id: 'home' }] });
  expect(findMenu(menus, 'location:footer')).toMatchObject({ id: 'footer', items: [{ type: 'page', page_id: 'home' }] });
  expect(findMenu(menus, 'location:footer')?.auto_add_pages).toBeUndefined();
  expect(menus[0]!.updated_at).toEqual(expect.any(String));
});
