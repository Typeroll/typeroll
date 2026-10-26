// Draft HTML must never be more permissive than saved HTML: editor previews
// and agents read working copies before any commit (security finding H1),
// and a page commit must not promote unsanitized HTML to the saved page.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const CTX = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };
const XSS = '<nav>Hej</nav><img src=x onerror=alert(1)><script>alert(2)</script><svg><style>&lt;img src=x onerror=alert(3)&gt;</style></svg>';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
});

function expectInert(html: string | undefined): void {
  expect(html).toContain('Hej');
  expect(html).not.toMatch(/<[^>]*\sonerror=|<script/i);
  expect(html).toContain('<svg><style>&lt;img src=x onerror=alert(3)&gt;</style></svg>');
}

describe('working copy HTML sanitization', () => {
  it('sanitizes partial html_content when the draft is stored', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(CTX, { kind: 'partial', id: 'header' }, { html_content: XSS });
    expectInert((await readWorkingCopy(CTX, { kind: 'partial', id: 'header' }))?.fields.html_content as string);
  });

  it('stores ordinary HTML unchanged', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await import('../../lib/working-copy');
    const html = '<nav class="site-nav"><a href="/">Home</a> <a href="/about">About</a></nav><style>.site-nav > a{color:red}</style><!-- typeroll:listing:news --><x-include name="cta"></x-include>';
    await mergeWorkingCopy(CTX, { kind: 'partial', id: 'footer' }, { html_content: html });
    expect((await readWorkingCopy(CTX, { kind: 'partial', id: 'footer' }))?.fields.html_content).toBe(html);
  });

  it('sanitizes page html_content on commit, also for drafts stored before sanitization', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'home', slug: 'home', status: 'draft', content_mode: 'html', blocks: [], html_content: '<p>Old</p>',
    });
    // A legacy draft written directly, bypassing mergeWorkingCopy.
    await getStore().setDoc(paths.workingCopy(ORG, SITE, 'page--home', MAIN_VERSION_ID), {
      kind: 'page', target_id: 'home', fields: { html_content: XSS }, updated_at: new Date().toISOString(),
    });
    const { commitWorkingCopy } = await import('../../lib/working-copy');
    expect((await commitWorkingCopy(CTX, { kind: 'page', id: 'home' }, 'x')).committed).toBe(true);
    const page = await getStore().getDoc<Page>(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID));
    expectInert(page?.html_content);
  });
});
