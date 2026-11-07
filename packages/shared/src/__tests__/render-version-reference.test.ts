/**
 * Reference output per render version.
 *
 * Every core block is rendered with fixed sample data at each released render
 * version, and its markup and CSS are compared with the stored reference. The
 * shared platform CSS is compared too. A change that alters the output for a
 * released version fails here: gate it on the next render version
 * (render-version.ts) instead, or, for a genuine bug fix that restores the
 * intended output, update the reference with `vitest -u` and note it in the
 * changelog. See docs/plans/design-system-and-render-versions.md.
 */
import { LEGACY_STANDARD_STYLES, standardStylesBefore037 } from './fixtures/legacy-standard-styles.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildCoreBlockRegistry,
  renderBlocks,
  collectBlockAssets,
  BLOCKS_RUNTIME_CSS,
  contentWellCss,
  FORM_SHELL_CSS,
  WEBFONT_FALLBACK_CSS,
  RENDER_VERSIONS,
  defaultSiteSettings,
  newSiteStyles,
  resolveBreakpointWidths,
  siteStylesCss,
  siteThemeCss,
} from '../index.js';
import type { Block, BlockType, FieldDefinition } from '../types.js';
import type { Menu } from '../menus.js';
import type { RenderBlocksOptions } from '../render-blocks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = buildCoreBlockRegistry();
const templateCss = (name: string) => readFileSync(resolve(HERE, '../../../site-template/src/styles', name), 'utf8');

function sampleValue(field: FieldDefinition): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'text': return field.required ? `Sample ${field.name}` : undefined;
    case 'textarea': return field.required ? `Sample ${field.name}` : undefined;
    case 'richtext': return '<p>Sample <strong>text</strong> with a <a href="/link">link</a>.</p>';
    case 'url': return field.required ? '/sample' : undefined;
    case 'image': return field.required ? '/media/sample.jpg' : undefined;
    default: return undefined;
  }
}

function sampleBlock(type: BlockType): Block {
  const data: Record<string, unknown> = {};
  for (const field of type.schema ?? []) {
    const value = sampleValue(field);
    if (value !== undefined) data[field.name] = value;
  }
  const block: Block = { id: 'ref', type: type.id, data };
  if (type.container === true) {
    block.children = [{ id: 'ref-child', type: 'core/prose', data: { html: '<p>Child</p>' } }];
  }
  return block;
}

/** A site menu with a plain submenu and a wide one (columns with headings). */
const SAMPLE_MENU: Menu = {
  id: 'main', name: 'Main', locations: ['primary'], items: [
    { id: 'home', type: 'url', href: '/', label: 'Home' },
    { id: 'services', type: 'page', page_id: 'services', children: [
      { id: 'design', type: 'page', page_id: 'design', description: 'Houses & schools' },
      { id: 'advice', type: 'url', href: '/advice/', label: 'Advice' },
    ] },
    { id: 'work', type: 'heading', label: 'Work', children: [
      { id: 'homes', type: 'heading', label: 'Homes', children: [{ id: 'villa', type: 'url', href: '/work/villa/', label: 'Villa' }] },
      { id: 'public', type: 'url', href: '/work/public/', label: 'Public', children: [{ id: 'school', type: 'url', href: '/work/school/', label: 'School' }] },
    ] },
  ],
};
const MENU_SOURCE: RenderBlocksOptions['menuSource'] = {
  menus: [SAMPLE_MENU],
  pages: () => [
    { id: 'services', title: 'Services', path: '/services/' },
    { id: 'design', title: 'Design', path: '/services/design/', parent: 'services' },
  ],
};

/** Extra samples for parts of a block that the default sample leaves empty. */
const EXTRA_SAMPLES: Array<{ name: string; block: Block; from?: number; options?: Partial<RenderBlocksOptions> }> = [
  {
    name: 'core__heading--grouped',
    block: {
      id: 'ref', type: 'core/heading',
      data: { text: 'Sample heading', level: 'h2', eyebrow: 'Sample eyebrow', subtitle: 'Sample subtitle', subtitle_style_id: 'lead' },
      style_overrides: { custom_class: 'custom-heading', html_id: 'sample-anchor' },
    },
  },
  {
    name: 'core__button--classed',
    block: { id: 'ref', type: 'core/button', data: { label: 'Sample', href: '/sample' }, style_overrides: { custom_class: 'custom-button' } },
  },
  {
    name: 'core__navigation_links--menu-row', from: 15, options: { menuSource: MENU_SOURCE, context: { page: { path: '/services/design/' } } },
    block: { id: 'ref', type: 'core/navigation_links', data: { source: 'menu', menu: 'location:primary', direction: 'row' } },
  },
  {
    name: 'core__navigation_links--menu-column', from: 15, options: { menuSource: MENU_SOURCE, context: { page: { path: '/' } } },
    block: { id: 'ref', type: 'core/navigation_links', data: { source: 'menu', menu: 'main', group_label: 'Explore' } },
  },
];

function render(type: BlockType, renderVersion: number, sample?: Block, options: Partial<RenderBlocksOptions> = {}): string {
  const block = sample ?? sampleBlock(type);
  let html: string;
  try {
    html = renderBlocks([block], { ...options, registry, renderVersion });
  } catch (error) {
    html = `<!-- render error: ${(error as Error).message} -->`;
  }
  const assets = collectBlockAssets([block], registry, { renderVersion });
  // Script is recorded only for the samples that pass options (added in version 15).
  return `${html}\n\n/* css */\n${assets.css}\n${options.menuSource && assets.js ? `\n/* js */\n${assets.js}\n` : ''}`;
}

const coreTypes = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));

/**
 * A palette where WCAG 2 and APCA pick different text colours for the
 * derived on_* tokens (dark text by WCAG 2, white by APCA).
 */
const SATURATED_COLORS = { ...defaultSiteSettings.colors, primary: '#3b82f6', secondary: '#00a19c', accent: '#e11d48' };

/** Site style and theme colour CSS (the derived on_* text colours, theme tokens). */
function themeColorCss(version: number): string {
  const breakpoints = resolveBreakpointWidths(undefined);
  return [
    ['siteStylesCss (standard styles, default palette)', siteStylesCss(version < 10 ? LEGACY_STANDARD_STYLES : version < 14 ? standardStylesBefore037(newSiteStyles()) : newSiteStyles(), { breakpoints, colors: defaultSiteSettings.colors, renderVersion: version })],
    ['siteStylesCss (no styles, saturated palette)', siteStylesCss([], { breakpoints, colors: SATURATED_COLORS, renderVersion: version })],
    ['siteStylesCss (standard styles, saturated palette)', siteStylesCss(version < 10 ? LEGACY_STANDARD_STYLES : version < 14 ? standardStylesBefore037(newSiteStyles()) : newSiteStyles(), { breakpoints, colors: SATURATED_COLORS, renderVersion: version })],
  ].map(([name, value]) => `/* ${name} */\n${value}`).join('\n\n') + '\n';
}

for (const { version } of RENDER_VERSIONS) {
  describe(`render version ${version}`, () => {
    it('keeps the shared platform CSS', async () => {
      const css = [
        ['BLOCKS_RUNTIME_CSS', BLOCKS_RUNTIME_CSS],
        ['CONTENT_WELL_CSS', contentWellCss(version)],
        ['FORM_SHELL_CSS', FORM_SHELL_CSS],
        ['WEBFONT_FALLBACK_CSS', WEBFONT_FALLBACK_CSS],
        // Head CSS that depends on the render version (font smoothing from v6).
        ['siteThemeCss (default settings)', siteThemeCss({ ...defaultSiteSettings, render_version: version })],
        ['site-template reset.css', templateCss('reset.css')],
        ['site-template global.css', templateCss('global.css')],
      ].map(([name, value]) => `/* ${name} */\n${value}`).join('\n\n');
      await expect(css).toMatchFileSnapshot(`./__render-reference__/v${version}/platform.css`);
    });

    it('keeps the site style and theme colour CSS', async () => {
      await expect(themeColorCss(version)).toMatchFileSnapshot(`./__render-reference__/v${version}/site-styles.css`);
    });

    for (const type of coreTypes) {
      it(`keeps ${type.id}`, async () => {
        await expect(render(type, version)).toMatchFileSnapshot(
          `./__render-reference__/v${version}/${type.id.replace('/', '__')}.html`,
        );
      });
    }

    for (const { name, block, options } of EXTRA_SAMPLES.filter(sample => version >= (sample.from ?? 1))) {
      it(`keeps ${name}`, async () => {
        await expect(render(registry.get(block.type)!, version, block, options)).toMatchFileSnapshot(
          `./__render-reference__/v${version}/${name}.html`,
        );
      });
    }
  });
}
