// Block.route_overrides: one block, different settings by route kind, with no
// site CSS and no duplicated block tree behind visibility branches.
import { describe, it, expect } from 'vitest';
import {
  ROUTE_KINDS,
  applyRouteOverrides,
  applyRouteOverridesToTree,
  blockTreeError,
  blockTreeWarnings,
  buildCoreBlockRegistry,
  collectBlockAssets,
  collectFontUsage,
  renderBlocks,
  routeOverridesError,
  unknownBlockFields,
  type Block,
  type RouteKind,
} from '../index.js';

const registry = buildCoreBlockRegistry();

/** The Moveria header banner: secondary everywhere, primary over the home page's teal hero. */
const banner = (): Block => ({
  id: 'banner',
  type: 'core/section',
  data: { background: 'secondary' },
  style_overrides: { custom_class: 'service-banner-header-surface' },
  route_overrides: { home: { data_overrides: { background: 'primary' } } },
  children: [{ id: 'text', type: 'core/prose', data: { html: '<p>Flyttstädning med garanti</p>' } }],
});

const render = (route?: RouteKind) => renderBlocks([banner()], { registry, renderVersion: 16, context: route ? { route } : {} });

describe('route_overrides rendering', () => {
  it('renders the home override on the home route and the base data on every other route kind', () => {
    expect(render('home')).toContain('--block-bg:var(--color-primary)');
    expect(render('home')).not.toContain('var(--color-secondary)');
    for (const route of ['page', 'item', 'facet'] as const) {
      expect(render(route)).toContain('--block-bg:var(--color-secondary)');
      expect(render(route)).not.toContain('var(--color-primary)');
    }
  });

  it('renders the base data when the context names no route', () => {
    expect(render()).toContain('--block-bg:var(--color-secondary)');
  });

  it('renders a block without route_overrides byte-identically on every route', () => {
    const plain: Block = { ...banner(), route_overrides: undefined };
    const base = renderBlocks([plain], { registry, renderVersion: 16 });
    for (const route of ROUTE_KINDS) expect(renderBlocks([plain], { registry, renderVersion: 16, context: { route } })).toBe(base);
  });

  it('applies overrides in nested blocks and leaves untouched subtrees as they are', () => {
    const tree: Block[] = [{ id: 'wrap', type: 'core/container', data: {}, children: [banner()] }, { id: 'other', type: 'core/prose', data: { html: '<p>x</p>' } }];
    const home = applyRouteOverridesToTree(tree, 'home');
    expect(home[0]!.children![0]!.data.background).toBe('primary');
    expect(home[1]).toBe(tree[1]);
    expect(applyRouteOverridesToTree(tree, 'page')).toBe(tree);
    expect(applyRouteOverridesToTree(tree, undefined)).toBe(tree);
    expect(applyRouteOverrides(tree[1]!, 'home')).toBe(tree[1]);
  });

  it('follows the route in asset collection, so per-route settings get their CSS', () => {
    // An item block chosen only on the home page ships its CSS there, and only there.
    const repeater: Block = {
      id: 'list', type: 'core/repeater', data: { item_block: 'core/prose', items: [{ html: 'a' }] },
      route_overrides: { home: { data_overrides: { item_block: 'core/heading', items: [{ text: 'a' }] } } },
    };
    expect(collectBlockAssets([repeater], registry, { route: 'home' }).used_ids).toContain('core/heading');
    expect(collectBlockAssets([repeater], registry, { route: 'page' }).used_ids).not.toContain('core/heading');
  });

  it('plans the fonts a route override chooses', () => {
    const block: Block = { id: 'p', type: 'core/prose', data: { html: '<p>x</p>', font: 'heading' }, route_overrides: { item: { data_overrides: { font_weight: '600' } } } };
    expect(collectFontUsage({ blocks: [block], blockTypes: registry }).heading.weights).toContain(600);
  });
});

describe('route_overrides validation', () => {
  it('accepts route kinds with data_overrides', () => {
    expect(routeOverridesError({ home: { data_overrides: { background: 'primary' } }, item: {}, facet: { data_overrides: {} } })).toBeNull();
    expect(blockTreeError([banner()])).toBeNull();
  });

  it('refuses a key that is not a route kind, naming the path', () => {
    const block = { ...banner(), route_overrides: { homepage: { data_overrides: { background: 'primary' } } } };
    expect(blockTreeError([block])).toMatch(/^blocks\[0\]\.route_overrides\.homepage is not a route kind/);
  });

  it('refuses overrides that are not objects of data_overrides', () => {
    expect(routeOverridesError([])).toMatch(/must be an object keyed by route kind/);
    expect(routeOverridesError({ home: 'primary' })).toMatch(/route_overrides\.home must be an object/);
    expect(routeOverridesError({ home: { background: 'primary' } })).toMatch(/route_overrides\.home\.background is not supported/);
    expect(routeOverridesError({ home: { data_overrides: ['primary'] } })).toMatch(/data_overrides must be an object/);
  });

  it('reports override keys no field of the block type declares, like data keys', () => {
    const block = { ...banner(), route_overrides: { home: { data_overrides: { backgroud: 'primary' } } } };
    const issues = unknownBlockFields(block, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'unknown_field', path: 'block.route_overrides.home.data_overrides.backgroud', key: 'backgroud' });
    expect(issues[0]!.suggestions).toContain('background');
  });

  it('warns on override values of the wrong type in tree writes', () => {
    const block = { ...banner(), route_overrides: { page: { data_overrides: { divider_top: 'zigzag' } } } };
    const warnings = blockTreeWarnings([block]);
    expect(warnings.some(warning => warning.code === 'field_type_mismatch' && warning.path === 'blocks[0].route_overrides.page.data_overrides.divider_top')).toBe(true);
  });
});
