// Pack/unpack round-trip + boundary tests for the .tcblocks format.

import { describe, it, expect } from 'vitest';
import { packBlockTypes, unpackBlockPackage, BlockPackageError } from '../../lib/block-packages';
import type { BlockType } from '@typeroll/shared';
import JSZip from 'jszip';

const sample: BlockType = {
  id: 'old-id-will-be-replaced',
  name: 'fancy_card',
  label: 'Fancy Card',
  icon: 'card',
  category: 'content',
  container: false,
  schema: [
    { name: 'title', type: 'text', label: 'Title', required: true },
    { name: 'body', type: 'richtext', label: 'Body' },
  ],
  template: '<div class="fancy"><h3>{{title}}</h3>{{{body}}}</div>',
  styles: '.fancy{border:1px solid #ccc;padding:1rem}',
  script: 'window.TyperollBlocks.register("fancy",function(){console.log("init")})',
  origin: 'user',
  created_at: '2026-05-22T10:00:00Z',
};

describe('packBlockTypes → unpackBlockPackage round-trip', () => {
  it('preserves schema, template, styles, and script', async () => {
    const buf = await packBlockTypes({
      manifest: { name: 'my-pack', version: '1.2.3' },
      block_types: [sample],
    });
    const result = await unpackBlockPackage(buf);
    expect(result.manifest.name).toBe('my-pack');
    expect(result.manifest.version).toBe('1.2.3');
    expect(result.blocks).toHaveLength(1);
    const bt = result.blocks[0].block_type;
    expect(bt.id).toBe('fancy_card');
    expect(bt.template).toBe(sample.template);
    expect(bt.styles).toBe(sample.styles);
    expect(bt.script).toBe(sample.script);
    expect(bt.schema).toEqual(sample.schema);
    expect(bt.origin).toBe('third_party');
    expect(bt.imported_from?.package_name).toBe('my-pack');
    expect(bt.imported_from?.version).toBe('1.2.3');
  });

  it('packs multiple blocks and keeps them distinct', async () => {
    const second: BlockType = { ...sample, name: 'simple_card', label: 'Simple', script: undefined };
    const buf = await packBlockTypes({
      manifest: { name: 'pack', version: '1' },
      block_types: [sample, second],
    });
    const result = await unpackBlockPackage(buf);
    expect(result.blocks.map((b) => b.id).sort()).toEqual(['fancy_card', 'simple_card']);
  });

  it('rejects packs with duplicate block names', async () => {
    await expect(
      packBlockTypes({
        manifest: { name: 'dup', version: '1' },
        block_types: [sample, sample],
      }),
    ).rejects.toThrow(/Duplicate/);
  });
});

describe('unpackBlockPackage — validation', () => {
  it('rejects missing manifest', async () => {
    const zip = new JSZip();
    zip.file('something.txt', 'not a manifest');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/Missing manifest/);
  });

  it('rejects malformed manifest', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{"not":"valid"}');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/manifest\.name/);
  });

  it('rejects path traversal in entry names', async () => {
    // JSZip strips leading "../" itself — to actually get a `..` segment
    // into the entry list we have to monkey-patch the entry name after
    // file() returns. The check should fire either way (traversal OR
    // absolute path are both rejected as 'unsafe').
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['b'] }));
    zip.file('legit/../evil.txt', 'pwn');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/unsafe|traversal|Absolute/i);
  });

  it('rejects absolute paths in entry names', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: [] }));
    zip.file('/etc/passwd', 'pwn');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/Absolute path/);
  });

  it('rejects unsafe block dir name in manifest', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['../escape'] }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    // Path-traversal check on the entry runs before block-name validation.
    await expect(unpackBlockPackage(buf)).rejects.toThrow();
  });

  it('warns but does not throw for a manifest block with no block.json', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['ghost'] }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await unpackBlockPackage(buf);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/ghost/);
    expect(result.blocks).toHaveLength(0);
  });

  it('rejects oversized zip', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024);
    await expect(unpackBlockPackage(big)).rejects.toThrowError(BlockPackageError);
  });

  it('rejects bad block.json category', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['b'] }));
    zip.file('b/block.json', JSON.stringify({ name: 'b', label: 'B', category: 'wrong', container: false, schema: [] }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/category/);
  });

  it('rejects bad block.json container', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['b'] }));
    zip.file('b/block.json', JSON.stringify({ name: 'b', label: 'B', category: 'content', container: 'bogus', schema: [] }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/container/);
  });

  it('requires slot_count when container = slots', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name: 'a', version: '1', blocks: ['b'] }));
    zip.file('b/block.json', JSON.stringify({
      name: 'b', label: 'B', category: 'layout', container: 'slots', schema: [],
    }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(unpackBlockPackage(buf)).rejects.toThrow(/slot_count/);
  });
});

describe('lossless packages', () => {
  it('keeps compositions, CSS scope, descriptions, aliases and field settings', async () => {
    const composed: BlockType = {
      id: 'icon_list', name: 'icon_list', label: 'Icon list', description: 'Benefits', category: 'content', container: false,
      item_compatible: true, css_scope: 'block', styles: ':scope { gap: 1rem }', origin: 'ai', created_at: '',
      schema: [{ name: 'items', type: 'array', label: 'Items', item_label: 'title', min_items: 1, max_items: 6, help: 'One per benefit',
        fields: [{ name: 'title', type: 'text', label: 'Title' }, { name: 'link', type: 'link', label: 'Link' }] }],
      composition: [{ id: 'list', type: 'core/repeater', data: { items: '{{props.items}}' }, children: [{ id: 't', type: 'core/text', data: { text: '{{item.title}}' } }] }],
    };
    const alias: BlockType = {
      id: 'benefit_grid', name: 'benefit_grid', label: 'Benefit grid', category: 'layout', container: 'repeater', created_at: '', schema: [],
      expand_to: { target: 'core/repeater', defaults: { item_block: 'icon_list', layout: 'grid' } },
    };
    const result = await unpackBlockPackage(await packBlockTypes({ manifest: { name: 'p', version: '1' }, block_types: [composed, alias] }));
    const [first, second] = result.blocks.map(block => block.block_type);
    expect(first).toMatchObject({ description: 'Benefits', item_compatible: true, css_scope: 'block', styles: composed.styles });
    expect(first!.composition).toEqual(composed.composition);
    expect(first!.schema).toEqual(composed.schema);
    expect(second).toMatchObject({ container: 'repeater', expand_to: alias.expand_to });
    // A stylesheet written before block scoping stays unscoped.
    const legacy = await unpackBlockPackage(await packBlockTypes({ manifest: { name: 'p', version: '1' }, block_types: [sample] }));
    expect(legacy.blocks[0]!.block_type.css_scope).toBeUndefined();
  });
});

describe('Round-trip via base64 (MCP path)', () => {
  it('packs to base64 and re-unpacks correctly', async () => {
    const buf = await packBlockTypes({
      manifest: { name: 'b64-pack', version: '1' },
      block_types: [sample],
    });
    const b64 = buf.toString('base64');
    const re = Buffer.from(b64, 'base64');
    const result = await unpackBlockPackage(re);
    expect(result.blocks[0].block_type.template).toBe(sample.template);
  });
});
