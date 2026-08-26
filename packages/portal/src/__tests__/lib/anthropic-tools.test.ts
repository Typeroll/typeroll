import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

// Tool-level tests for the chat surface. These exercise runTool() against the
// fixtures datastore — no Anthropic client needed.

const ORG = 'testorg';
const SITE = 'mysite';

interface Setup {
  ctx: import('../../lib/anthropic').ToolContext;
  runTool: typeof import('../../lib/anthropic').runTool;
}

async function setup(): Promise<Setup> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { runTool } = await import('../../lib/anthropic');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  });
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const ctx: import('../../lib/anthropic').ToolContext = {
    orgId: ORG,
    siteId: SITE,
    versionId: MAIN_VERSION_ID,
    site: { id: SITE, name: 'My Site' } as Site,
    version: null,
    portalOrigin: 'http://localhost:4321',
  };
  return { ctx, runTool };
}

async function seedPage(id: string, html: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id,
    slug: id,
    content_mode: 'html',
    status: 'published',
    html_content: html,
  });
}

describe('find_pages_using_block', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('returns only the pages that include the named block', async () => {
    const { ctx, runTool } = await setup();
    await seedPage('home', '<section>hi</section><x-include name="cta" />');
    await seedPage('about', '<p>about</p>');
    await seedPage('pricing', '<x-include name="cta"></x-include>');

    const out = await runTool('find_pages_using_block', { partial_id: 'cta' }, ctx);
    const r = out.result as { partial_id: string; auto_injected: boolean; pages: Array<{ page_id: string }> };

    expect(r.partial_id).toBe('cta');
    expect(r.auto_injected).toBe(false);
    expect(r.pages.map((p) => p.page_id).sort()).toEqual(['home', 'pricing']);
  });

  it('does not match when the name attribute differs', async () => {
    const { ctx, runTool } = await setup();
    await seedPage('home', '<x-include name="newsletter" />');
    await seedPage('about', '<x-include name="cta-2" />');

    const out = await runTool('find_pages_using_block', { partial_id: 'cta' }, ctx);
    const r = out.result as { pages: unknown[] };
    expect(r.pages).toEqual([]);
  });

  it('treats header/footer as auto-injected and returns all pages', async () => {
    const { ctx, runTool } = await setup();
    await seedPage('home', '<h1>hello</h1>');
    await seedPage('about', '<p>about</p>');

    const out = await runTool('find_pages_using_block', { partial_id: 'header' }, ctx);
    const r = out.result as { auto_injected: boolean; pages: Array<{ page_id: string }> };
    expect(r.auto_injected).toBe(true);
    expect(r.pages.map((p) => p.page_id).sort()).toEqual(['about', 'home']);
  });

  it('rejects an empty partial_id', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('find_pages_using_block', { partial_id: '' }, ctx);
    expect((out.result as { error?: string }).error).toBeTruthy();
  });

  it('escapes regex metachars in the partial id (no false matches)', async () => {
    const { ctx, runTool } = await setup();
    await seedPage('home', '<x-include name="cta-x" />');

    // ".*" as a partial id would otherwise become a wildcard.
    const out = await runTool('find_pages_using_block', { partial_id: '.*' }, ctx);
    const r = out.result as { pages: unknown[] };
    expect(r.pages).toEqual([]);
  });
});

describe('list_blocks_with_usage', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('counts pages per block and flags header/footer as auto-injected', async () => {
    const { ctx, runTool } = await setup();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    // Two pages, one with a cta include.
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', content_mode: 'html', status: 'published',
      html_content: '<x-include name="cta" />',
    });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, {
      title: 'About', slug: 'about', content_mode: 'html', status: 'published',
      html_content: '<p>about</p>',
    });
    // A header, a footer, and a free block.
    await store.setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/header`, {
      name: 'Header', kind: 'header', status: 'published', html_content: '<nav></nav>',
    });
    await store.setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/footer`, {
      name: 'Footer', kind: 'footer', status: 'published', html_content: '<footer></footer>',
    });
    await store.setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/cta`, {
      name: 'CTA', kind: 'free', status: 'published', html_content: '<div>cta</div>',
    });

    const out = await runTool('list_blocks_with_usage', {}, ctx);
    const r = out.result as Array<{ id: string; auto_injected: boolean; used_on_pages: number }>;
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(byId.header).toMatchObject({ auto_injected: true, used_on_pages: 2 });
    expect(byId.footer).toMatchObject({ auto_injected: true, used_on_pages: 2 });
    expect(byId.cta).toMatchObject({ auto_injected: false, used_on_pages: 1 });
  });
});


describe('buildChatSystemPrompt active page context', () => {
  it('omits the current-page block when no active page is set', async () => {
    const { buildChatSystemPrompt } = await import('../../lib/anthropic');
    const prompt = buildChatSystemPrompt('My Site', null, null);
    expect(prompt).not.toContain('The customer is currently editing');
  });

  it('renders the active page in the prompt when provided', async () => {
    const { buildChatSystemPrompt } = await import('../../lib/anthropic');
    const prompt = buildChatSystemPrompt('My Site', null, {
      id: 'about',
      title: 'About Us',
      slug: 'about',
    });
    expect(prompt).toContain('"About Us"');
    expect(prompt).toContain('id: `about`');
    expect(prompt).toContain('slug: `/about`');
    // The default scoping rule still applies; the active page just resolves
    // ambiguity, it doesn't remove the rule itself.
    expect(prompt).toContain('Scope: default to the page in front of the user');
  });
});

describe('playbook covers site-wide changes', () => {
  it('mentions the site-wide change recipe', async () => {
    const { PLAYBOOK_STARTER } = await import('../../lib/playbook');
    expect(PLAYBOOK_STARTER).toContain('site-wide change');
    expect(PLAYBOOK_STARTER).toContain('list_partials');
    expect(PLAYBOOK_STARTER).toContain('find_pages_using_block');
    expect(PLAYBOOK_STARTER).toContain('<x-include');
  });

  it('mentions the opportunistic-extraction pattern', async () => {
    const { PLAYBOOK_STARTER } = await import('../../lib/playbook');
    expect(PLAYBOOK_STARTER).toContain('Opportunistic extraction');
    expect(PLAYBOOK_STARTER).toContain('list_blocks_with_usage');
  });
});

describe('create_page slug validation (regression — docs/page-slug-audit.md)', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('rejects a slug containing a slash without writing the doc', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool(
      'create_page',
      { title: 'My Post', slug: 'blog/my-post', html_content: '<p>hi</p>' },
      ctx,
    );
    // runTool returns { result: ... } where result is the tool's own
    // shape — for the create_page error path that's { error: '...' }.
    const r = out.result as Record<string, unknown>;
    expect(r.error).toBeTruthy();
    expect(String(r.error)).toMatch(/slash/i);
    expect(String(r.error)).toMatch(/collection|route_template|`path`|path field/i);

    // No doc must have been created under the broken path. Both the legit
    // sub-collection shape (`pages/blog/my-post`) and the literal slash-id
    // shape would be visible in vstore.pages, so an empty list is the
    // only valid outcome.
    const { vstore } = await import('../../lib/version-store');
    const pages = await vstore.pages(ORG, SITE, MAIN_VERSION_ID);
    expect(pages.length).toBe(0);
  });

  it('strips leading/trailing slashes and accepts the result', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool(
      'create_page',
      { title: 'About', slug: '/about/', html_content: '<p>hi</p>' },
      ctx,
    );
    // Leading/trailing slashes get normalised away, only internal slashes
    // are the gate.
    const r = out.result as Record<string, unknown>;
    expect(r.error).toBeFalsy();
    expect(r.slug).toBe('about');
  });
});

// BlockType authoring via chat tools. These tools must (a) write to the
// per-site block_types collection, (b) stamp origin='ai', (c) NEVER
// persist a `script` field even if the model includes one in the input,
// (d) leave core blocks read-only.

describe('create_block_type', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('creates a block type with origin=ai stamped automatically', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool(
      'create_block_type',
      {
        name: 'fancy_card',
        label: 'Fancy Card',
        category: 'content',
        container: false,
        schema: [
          { name: 'heading', type: 'text', label: 'Heading' },
          { name: 'body', type: 'richtext', label: 'Body' },
        ],
        template: '<article data-block="fancy_card"><h2>{{heading}}</h2>{{{body}}}</article>',
        styles: '[data-block="fancy_card"]{padding:1rem}',
      },
      ctx,
    );
    const r = out.result as { ok: boolean; block_type: import('@typeroll/shared').BlockType };
    expect(r.ok).toBe(true);
    expect(r.block_type.id).toBe('fancy_card');
    expect(r.block_type.origin).toBe('ai');
    expect(r.block_type.schema).toHaveLength(2);

    // Verify it's in the datastore at the expected path
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/fancy_card`,
    );
    expect(doc).toBeTruthy();
  });

  it('NEVER persists the script field even if the model sends one', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool(
      'create_block_type',
      {
        name: 'sneaky_block',
        label: 'Sneaky',
        template: '<div data-block="sneaky_block">hi</div>',
        // Model attempts to inject a script — must be filtered:
        script: 'alert(document.cookie)',
      } as Record<string, unknown>,
      ctx,
    );
    const r = out.result as { block_type: import('@typeroll/shared').BlockType };
    expect(r.block_type.script).toBeUndefined();

    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<import('@typeroll/shared').BlockType>(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/sneaky_block`,
    );
    expect(doc?.script).toBeUndefined();
  });

  it('rejects invalid names', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool(
      'create_block_type',
      { name: 'Bad Name With Spaces' },
      ctx,
    );
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/name/i);
  });

  it('rejects duplicate ids', async () => {
    const { ctx, runTool } = await setup();
    await runTool('create_block_type', { name: 'dup' }, ctx);
    const out = await runTool('create_block_type', { name: 'dup' }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/exist/i);
  });
});

describe('update_block_type', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('updates whitelisted fields and shallow-merges into the existing doc', async () => {
    const { ctx, runTool } = await setup();
    await runTool('create_block_type', {
      name: 'note',
      label: 'Note',
      template: '<p data-block="note">{{text}}</p>',
      schema: [{ name: 'text', type: 'text', label: 'Text' }],
    }, ctx);

    const out = await runTool('update_block_type', {
      id: 'note',
      label: 'Renamed Note',
      template: '<aside data-block="note">{{text}}</aside>',
    }, ctx);
    const r = out.result as { block_type: import('@typeroll/shared').BlockType };
    expect(r.block_type.label).toBe('Renamed Note');
    expect(r.block_type.template).toContain('<aside');
    // Schema preserved (wasn't in the patch)
    expect(r.block_type.schema).toHaveLength(1);
    expect(r.block_type.origin).toBe('ai');           // origin not overwritten
  });

  it('refuses to edit core blocks', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('update_block_type', {
      id: 'core/heading',
      label: 'Hax',
    }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/core/i);
  });

  it('does NOT update the script field even if sent', async () => {
    const { ctx, runTool } = await setup();
    await runTool('create_block_type', {
      name: 'note',
      template: '<p data-block="note">{{text}}</p>',
    }, ctx);
    await runTool('update_block_type', {
      id: 'note',
      label: 'New Label',
      script: 'alert(1)',
    } as Record<string, unknown>, ctx);
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<import('@typeroll/shared').BlockType>(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/note`,
    );
    expect(doc?.label).toBe('New Label');
    expect(doc?.script).toBeUndefined();
  });

  it('returns error when type is missing', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('update_block_type', { id: 'nope', label: 'x' }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/not found/i);
  });
});

describe('delete_block_type', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('removes a custom block type', async () => {
    const { ctx, runTool } = await setup();
    await runTool('create_block_type', { name: 'tmp', template: '<div data-block="tmp"></div>' }, ctx);
    const out = await runTool('delete_block_type', { id: 'tmp' }, ctx);
    const r = out.result as { ok?: boolean };
    expect(r.ok).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc(
      `${paths.blockTypes(ORG, SITE, MAIN_VERSION_ID)}/tmp`,
    );
    expect(doc).toBeNull();
  });

  it('refuses to delete core blocks', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('delete_block_type', { id: 'core/heading' }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/core/i);
  });

  it('returns error when type is missing', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('delete_block_type', { id: 'ghost' }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/not found/i);
  });
});

// Block-instance tools now accept `target: { kind, id }` for partials and
// templates in addition to the legacy `page_id` shorthand. These tests
// exercise the new dispatcher.

describe('block instance tools — partial target', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function seedPartial(id: string, blocks: import('@typeroll/shared').Block[] = []): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/${id}`,
      {
        id, name: id, kind: id === 'header' || id === 'footer' ? id : 'free',
        content_mode: 'blocks', blocks, status: 'published',
      } as Record<string, unknown>,
    );
  }

  it('add_block can insert into the header partial', async () => {
    const { ctx, runTool } = await setup();
    await seedPartial('header', []);

    const out = await runTool('add_block', {
      target: { kind: 'partial', id: 'header' },
      block: { type: 'core/heading', data: { text: 'Site nav', level: 'h1', size: 'auto', align: 'left', eyebrow: '' } },
    }, ctx);
    const r = out.result as { ok?: boolean; added_id?: string };
    expect(r.ok).toBe(true);
    expect(r.added_id).toBeTruthy();

    // Buffer model: the mutation lands in the partial's WORKING COPY; the
    // saved partial is untouched until an explicit save/commit.
    const { getStore } = await import('../../lib/datastore');
    const saved = await getStore().getDoc<import('@typeroll/shared').Partial>(
      `${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/header`,
    );
    expect(saved?.blocks ?? []).toHaveLength(0);

    const { readWorkingCopy, commitWorkingCopy } = await import('../../lib/working-copy');
    const CTX = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };
    const wc = await readWorkingCopy(CTX, { kind: 'partial', id: 'header' });
    expect((wc?.fields.blocks as unknown[]).length).toBe(1);

    await commitWorkingCopy(CTX, { kind: 'partial', id: 'header' }, 'test');
    const partial = await getStore().getDoc<import('@typeroll/shared').Partial>(
      `${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/header`,
    );
    expect(partial?.blocks).toHaveLength(1);
    expect(partial?.blocks?.[0].type).toBe('core/heading');
  });

  it('get_page_blocks reads the partial tree', async () => {
    const { ctx, runTool } = await setup();
    await seedPartial('footer', [
      { id: 'b1', type: 'core/prose', data: { html: '<p>© 2026</p>' } },
    ]);

    const out = await runTool('get_page_blocks', {
      target: { kind: 'partial', id: 'footer' },
    }, ctx);
    const r = out.result as { content_mode: string; blocks: import('@typeroll/shared').Block[] };
    expect(r.content_mode).toBe('blocks');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].id).toBe('b1');
  });

  it('rejects html-mode partials', async () => {
    const { ctx, runTool } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/legacy`,
      {
        id: 'legacy', name: 'legacy', kind: 'free',
        content_mode: 'html', html_content: '<p>raw</p>', status: 'published',
      } as Record<string, unknown>,
    );

    const out = await runTool('add_block', {
      target: { kind: 'partial', id: 'legacy' },
      block: { type: 'core/heading', data: {} },
    }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/html-mode/i);
  });

  it('update_block + duplicate_block round-trip in a partial', async () => {
    const { ctx, runTool } = await setup();
    await seedPartial('cta-bar', [
      { id: 'card1', type: 'core/heading', data: { text: 'Original', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } },
    ]);

    // Duplicate
    const dup = await runTool('duplicate_block', {
      target: { kind: 'partial', id: 'cta-bar' },
      block_id: 'card1',
    }, ctx);
    const dupId = (dup.result as { duplicate_id?: string }).duplicate_id;
    expect(dupId).toBeTruthy();

    // Update the duplicate
    await runTool('update_block', {
      target: { kind: 'partial', id: 'cta-bar' },
      block_id: dupId!,
      data: { text: 'Modified copy' },
    }, ctx);

    // Mutations chained on the same working copy see each other; the saved
    // partial gets them at commit.
    const { commitWorkingCopy } = await import('../../lib/working-copy');
    await commitWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'partial', id: 'cta-bar' },
      'test',
    );
    const { getStore } = await import('../../lib/datastore');
    const partial = await getStore().getDoc<import('@typeroll/shared').Partial>(
      `${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/cta-bar`,
    );
    expect(partial?.blocks).toHaveLength(2);
    const updated = partial?.blocks?.find((b) => b.id === dupId);
    expect((updated?.data as { text?: string }).text).toBe('Modified copy');
  });
});

describe('block instance tools — template target', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function seedTemplate(id: string, blocks: import('@typeroll/shared').Block[] = []): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.pageTemplates(ORG, SITE, MAIN_VERSION_ID)}/${id}`,
      {
        id, name: id, label: id,
        applies_to: 'any',
        blocks,
        status: 'published',
        created_at: new Date().toISOString(),
      } as Record<string, unknown>,
    );
  }

  it('add_block inserts into a template tree', async () => {
    const { ctx, runTool } = await setup();
    await seedTemplate('blog-post', [
      { id: 'slot1', type: 'template_content_slot', data: {} },
    ]);

    const out = await runTool('add_block', {
      target: { kind: 'template', id: 'blog-post' },
      block: { type: 'template/page_title', data: { level: 'h1', size: 'auto', align: 'left' } },
      position: 0,
    }, ctx);
    const r = out.result as { ok?: boolean; added_id?: string };
    expect(r.ok).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const tpl = await getStore().getDoc<import('@typeroll/shared').PageTemplate>(
      `${paths.pageTemplates(ORG, SITE, MAIN_VERSION_ID)}/blog-post`,
    );
    expect(tpl?.blocks).toHaveLength(2);
    // The page_title block was inserted at position 0; the slot moved to 1
    expect(tpl?.blocks?.[0].type).toBe('template/page_title');
    expect(tpl?.blocks?.[1].type).toBe('template_content_slot');
  });

  it('returns 404 for missing template', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('add_block', {
      target: { kind: 'template', id: 'nope' },
      block: { type: 'core/heading', data: {} },
    }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/not found/i);
  });
});

describe('block instance tools — item_template target', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function seedCollection(name: string, item_template_blocks?: import('@typeroll/shared').Block[]): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.collections(ORG, SITE, MAIN_VERSION_ID)}/${name}`,
      {
        id: name, name,
        label_singular: 'Post', label_plural: 'Posts',
        fields: [
          { name: 'title', type: 'text', label: 'Title' },
          { name: 'body', type: 'richtext', label: 'Body' },
        ],
        item_template_blocks,
        created_at: new Date().toISOString(),
      } as Record<string, unknown>,
    );
  }

  it('add_block writes to the collection\'s item_template_blocks field', async () => {
    const { ctx, runTool } = await setup();
    await seedCollection('blog');

    const out = await runTool('add_block', {
      target: { kind: 'item_template', id: 'blog' },
      block: { type: 'template/item_title', data: { level: 'h1', size: 'auto', align: 'left' } },
    }, ctx);
    const r = out.result as { ok?: boolean; added_id?: string };
    expect(r.ok).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const coll = await getStore().getDoc<import('@typeroll/shared').CollectionDef>(
      `${paths.collections(ORG, SITE, MAIN_VERSION_ID)}/blog`,
    );
    expect(coll?.item_template_blocks).toHaveLength(1);
    expect(coll?.item_template_blocks?.[0].type).toBe('template/item_title');
  });

  it('get_page_blocks returns the item_template tree', async () => {
    const { ctx, runTool } = await setup();
    await seedCollection('blog', [
      { id: 'b1', type: 'template/item_title', data: { level: 'h1' } },
      { id: 'b2', type: 'template/item_body', data: { max_width: 'normal' } },
    ]);

    const out = await runTool('get_page_blocks', {
      target: { kind: 'item_template', id: 'blog' },
    }, ctx);
    const r = out.result as { content_mode: string; blocks: import('@typeroll/shared').Block[] };
    expect(r.content_mode).toBe('blocks');
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].type).toBe('template/item_title');
  });

  it('returns 404 for missing collection', async () => {
    const { ctx, runTool } = await setup();
    const out = await runTool('add_block', {
      target: { kind: 'item_template', id: 'nope' },
      block: { type: 'template/item_title', data: {} },
    }, ctx);
    const r = out.result as { error?: string };
    expect(r.error).toMatch(/not found/i);
  });

  it('move + remove + update round-trip in an item template', async () => {
    const { ctx, runTool } = await setup();
    await seedCollection('blog', [
      { id: 'b1', type: 'template/item_title', data: { level: 'h1' } },
      { id: 'b2', type: 'template/item_body', data: { max_width: 'normal' } },
    ]);

    // Reorder: put body before title
    await runTool('move_block', {
      target: { kind: 'item_template', id: 'blog' },
      block_id: 'b2',
      target_position: 0,
    }, ctx);

    // Update the title's level
    await runTool('update_block', {
      target: { kind: 'item_template', id: 'blog' },
      block_id: 'b1',
      data: { level: 'h2' },
    }, ctx);

    const { getStore } = await import('../../lib/datastore');
    const coll = await getStore().getDoc<import('@typeroll/shared').CollectionDef>(
      `${paths.collections(ORG, SITE, MAIN_VERSION_ID)}/blog`,
    );
    expect(coll?.item_template_blocks?.[0].id).toBe('b2');
    expect(coll?.item_template_blocks?.[1].id).toBe('b1');
    expect((coll?.item_template_blocks?.[1].data as { level?: string }).level).toBe('h2');
  });
});

describe('block instance tools — back-compat with page_id', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('legacy page_id still works on add_block', async () => {
    const { ctx, runTool } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      id: 'home', title: 'Home', slug: 'home',
      content_mode: 'blocks', status: 'published',
      blocks: [],
    });

    const out = await runTool('add_block', {
      page_id: 'home',
      block: { type: 'core/heading', data: { text: 'Hello', level: 'h1', size: 'auto', align: 'left', eyebrow: '' } },
    }, ctx);
    const r = out.result as { ok?: boolean; added_id?: string };
    expect(r.ok).toBe(true);
    expect(r.added_id).toBeTruthy();
  });
});

describe('update_site_settings whitelist', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('round-trips default_meta_description but still drops scriptable surfaces', async () => {
    const { ctx, runTool } = await setup();

    await runTool('update_site_settings', {
      default_meta_description: 'Fallback description for all pages.',
      default_seo_suffix: ' | My Site',
      scripts_head: '<script>alert(1)</script>',
    }, ctx);

    const { vstore } = await import('../../lib/version-store');
    const settings = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as unknown as Record<string, unknown>;
    expect(settings.default_meta_description).toBe('Fallback description for all pages.');
    expect(settings.default_seo_suffix).toBe(' | My Site');
    expect(settings.scripts_head).toBeUndefined();
  });
});
