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
    const partial = await getStore().getDoc<{ html_content: string; status: string }>(paths.partial('org', siteId, kind));
    expect(partial?.status).toBe('published');
    expect(internalLinks(partial!.html_content).every(href => href === '/')).toBe(true);
  }
  expect(internalLinks(defaultHeaderHtml('Fresh Site'))).toContain('/');
});

it('keeps the brand and copyright in the starter header and footer', () => {
  expect(defaultHeaderHtml('Acme & Co')).toContain('Acme &amp; Co');
  expect(defaultFooterHtml('Acme', 'Tagline')).toMatch(/Tagline[\s\S]*&copy; \d{4} Acme/);
});
