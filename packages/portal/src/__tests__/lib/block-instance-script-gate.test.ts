/**
 * The instance-data script gate.
 *
 * `gateBlockScript` guards `BlockType.script` — per-TYPE JS — and is called
 * from the block-type routes. Block INSTANCE writes (add_block/update_block/
 * set_block_responsive) never passed through it, so the moment a block type
 * carries code in `block.data`, the chat AI could ship visitor-executed JS
 * around the gate built to stop exactly that.
 *
 * The fix is declarative: a type names its code fields in
 * `BlockType.script_fields` and the generic write path gates whatever is
 * named. These tests pin the mechanism so a future `core/embed` inherits it
 * by declaring the field rather than by someone remembering a call site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { BlockType } from '@typeroll/shared';

const ORG = 'default';
const SITE = 'mysite';
const VERSION = 'main';

/** A block type that renders one of its data fields as executable code. */
const EMBED_TYPE: Partial<BlockType> = {
  name: 'embed',
  label: 'Embed',
  category: 'custom',
  origin: 'user',
  schema: [
    { name: 'html', type: 'textarea', label: 'HTML' },
    { name: 'js', type: 'textarea', label: 'JS' },
  ],
  script_fields: ['js'],
};

async function seedType(extra: Partial<BlockType> = {}) {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(
    paths.blockType(ORG, SITE, 'user/embed', VERSION),
    { ...EMBED_TYPE, ...extra },
  );
}

describe('resolveScriptFields', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('reads script_fields off a per-site block type', async () => {
    await seedType();
    const { resolveScriptFields } = await import('../../lib/block-script-gate');
    expect(await resolveScriptFields(ORG, SITE, VERSION, 'user/embed')).toEqual(['js']);
  });

  it('returns nothing for core block types — none carry code in data', async () => {
    const { resolveScriptFields } = await import('../../lib/block-script-gate');
    expect(await resolveScriptFields(ORG, SITE, VERSION, 'core/heading')).toEqual([]);
    // …and resolving a core type must not cost a datastore read, which is why
    // core is checked before the per-site lookup. (Asserted indirectly: this
    // passes with no fixtures seeded at all.)
  });

  it('returns nothing for an unknown type rather than throwing', async () => {
    const { resolveScriptFields } = await import('../../lib/block-script-gate');
    expect(await resolveScriptFields(ORG, SITE, VERSION, 'user/nope')).toEqual([]);
    expect(await resolveScriptFields(ORG, SITE, VERSION, undefined)).toEqual([]);
  });
});

describe('gateBlockInstanceScript (chat surface)', () => {
  it('strips declared code fields when the site has not opted in', async () => {
    const { gateBlockInstanceScript } = await import('../../lib/block-script-gate');
    const data: Record<string, unknown> = { html: '<div></div>', js: 'fetch("/steal")' };
    const warnings = gateBlockInstanceScript(data, ['js'], { ai_scripts_enabled: false });

    expect(data.js).toBeUndefined();
    // The non-code field survives — the gate removes JS, not the whole write.
    expect(data.html).toBe('<div></div>');
    expect(warnings).toHaveLength(1);
  });

  it('passes them through once an admin enables ai_scripts_enabled', async () => {
    const { gateBlockInstanceScript } = await import('../../lib/block-script-gate');
    const data: Record<string, unknown> = { js: 'console.log(1)' };
    expect(gateBlockInstanceScript(data, ['js'], { ai_scripts_enabled: true })).toEqual([]);
    expect(data.js).toBe('console.log(1)');
  });

  it('leaves data alone when the type declares no code fields', async () => {
    const { gateBlockInstanceScript } = await import('../../lib/block-script-gate');
    // A field literally named `js` on a type that never declared it is just
    // data — the type's declaration is what makes a field executable, not its
    // name.
    const data: Record<string, unknown> = { js: 'not actually code here' };
    expect(gateBlockInstanceScript(data, [], { ai_scripts_enabled: false })).toEqual([]);
    expect(data.js).toBe('not actually code here');
  });

  it('is silent when the write simply omits the code field', async () => {
    const { gateBlockInstanceScript } = await import('../../lib/block-script-gate');
    const data: Record<string, unknown> = { html: '<p>hi</p>' };
    expect(gateBlockInstanceScript(data, ['js'], { ai_scripts_enabled: false })).toEqual([]);
  });
});

describe('blockDataCarriesScript (bearer surfaces)', () => {
  it('detects a declared code field so the route can attach the notice', async () => {
    const { blockDataCarriesScript } = await import('../../lib/block-script-gate');
    expect(blockDataCarriesScript({ js: 'x' }, ['js'])).toBe(true);
    expect(blockDataCarriesScript({ html: 'x' }, ['js'])).toBe(false);
    expect(blockDataCarriesScript(undefined, ['js'])).toBe(false);
    expect(blockDataCarriesScript({ js: 'x' }, [])).toBe(false);
  });

  it('treats an empty string as a write — clearing JS is still a JS write', async () => {
    const { blockDataCarriesScript } = await import('../../lib/block-script-gate');
    expect(blockDataCarriesScript({ js: '' }, ['js'])).toBe(true);
  });
});

describe('script_fields is not writable through an agent surface', () => {
  // The gate is only as strong as the declaration it reads. If an agent could
  // clear script_fields on a block type, it would ungate the field and then
  // write JS into it through update_block — the exact bypass this whole
  // mechanism exists to close. Source-level guard, in the same spirit as
  // site-access-org-id-discipline.test.ts.
  const read = async (p: string) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.resolve(process.cwd(), p), 'utf8');
  };

  it('is absent from the v1 block-types WRITABLE whitelist', async () => {
    const src = await read('src/pages/api/v1/sites/[siteId]/block-types/index.ts');
    const whitelist = src.slice(src.indexOf('const WRITABLE'), src.indexOf('function sanitizeWrite'));
    expect(whitelist).not.toContain('script_fields');
  });

  it("is absent from the chat's block-type patch builders", async () => {
    const src = await read('src/lib/anthropic.ts');
    expect(src).not.toContain('patch.script_fields');
    expect(src).not.toContain('input.script_fields');
  });
});

describe('the gate is reachable from the chat tool path', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('add_block through the chat drops JS on a gated site', async () => {
    await seedType();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), {
      name: 'Mine', hosting_adapter: 'cloudflare', ai_scripts_enabled: false,
    });
    await store.setDoc(paths.page(ORG, SITE, 'home'), {
      title: 'Home', slug: 'home', status: 'published',
      content_mode: 'blocks', blocks: [],
    });

    const { runTool } = await import('../../lib/anthropic');
    const ctx = {
      orgId: ORG, siteId: SITE, versionId: VERSION,
      site: { id: SITE, name: 'Mine', ai_scripts_enabled: false },
      version: null, portalOrigin: 'https://app.typeroll.com',
    };
    const res = await runTool('add_block', {
      target: { kind: 'page', id: 'home' },
      block: { type: 'user/embed', data: { html: '<div></div>', js: 'alert(1)' } },
    }, ctx as never);

    expect((res.result as { ok?: boolean }).ok).toBe(true);
    expect((res.result as { warnings?: string[] }).warnings).toHaveLength(1);

    // And the JS really didn't land in the stored tree.
    const { loadContainer } = await import('../../lib/block-containers');
    const loaded = await loadContainer({ kind: 'page', id: 'home' }, ctx as never);
    const stored = loaded.blocks[0];
    expect(stored.type).toBe('user/embed');
    expect(stored.data.html).toBe('<div></div>');
    expect(stored.data.js).toBeUndefined();
  });
});
