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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildCoreBlockRegistry,
  renderBlocks,
  collectBlockAssets,
  BLOCKS_RUNTIME_CSS,
  CONTENT_WELL_CSS,
  FORM_SHELL_CSS,
  WEBFONT_FALLBACK_CSS,
  RENDER_VERSIONS,
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

function render(type: BlockType, renderVersion: number): string {
  const block = sampleBlock(type);
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

for (const { version } of RENDER_VERSIONS) {
  describe(`render version ${version}`, () => {
    it('keeps the shared platform CSS', async () => {
      const css = [
        ['BLOCKS_RUNTIME_CSS', BLOCKS_RUNTIME_CSS],
        ['CONTENT_WELL_CSS', CONTENT_WELL_CSS],
        ['FORM_SHELL_CSS', FORM_SHELL_CSS],
        ['WEBFONT_FALLBACK_CSS', WEBFONT_FALLBACK_CSS],
        ['site-template reset.css', templateCss('reset.css')],
        ['site-template global.css', templateCss('global.css')],
      ].map(([name, value]) => `/* ${name} */\n${value}`).join('\n\n');
      await expect(css).toMatchFileSnapshot(`./__render-reference__/v${version}/platform.css`);
    });

    for (const type of coreTypes) {
      it(`keeps ${type.id}`, async () => {
        await expect(render(type, version)).toMatchFileSnapshot(
          `./__render-reference__/v${version}/${type.id.replace('/', '__')}.html`,
        );
      });
    }
  });
}
