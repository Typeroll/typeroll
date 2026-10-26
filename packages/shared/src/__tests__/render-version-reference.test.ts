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
import { LEGACY_STANDARD_STYLES } from './fixtures/legacy-standard-styles.js';
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

/** Extra samples for parts of a block that the default sample leaves empty. */
const EXTRA_SAMPLES: Array<{ name: string; block: Block }> = [
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
];

function render(type: BlockType, renderVersion: number, sample?: Block): string {
  const block = sample ?? sampleBlock(type);
  let html: string;
  try {
    html = renderBlocks([block], { registry, renderVersion });
  } catch (error) {
    html = `<!-- render error: ${(error as Error).message} -->`;
  }
  const css = collectBlockAssets([block], registry, { renderVersion }).css;
  return `${html}\n\n/* css */\n${css}\n`;
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
    ['siteStylesCss (standard styles, default palette)', siteStylesCss(version < 10 ? LEGACY_STANDARD_STYLES : newSiteStyles(), { breakpoints, colors: defaultSiteSettings.colors, renderVersion: version })],
    ['siteStylesCss (no styles, saturated palette)', siteStylesCss([], { breakpoints, colors: SATURATED_COLORS, renderVersion: version })],
    ['siteStylesCss (standard styles, saturated palette)', siteStylesCss(version < 10 ? LEGACY_STANDARD_STYLES : newSiteStyles(), { breakpoints, colors: SATURATED_COLORS, renderVersion: version })],
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

    for (const { name, block } of EXTRA_SAMPLES) {
      it(`keeps ${name}`, async () => {
        await expect(render(registry.get(block.type)!, version, block)).toMatchFileSnapshot(
          `./__render-reference__/v${version}/${name}.html`,
        );
      });
    }
  });
}
