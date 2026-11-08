import { describe, expect, it } from 'vitest';
import {
  BLOCK_CLIPBOARD_MAX_BYTES, blockClipboardCount, blockClipboardErrors, blockClipboardHtml, blocksPlainText, buildBlockClipboard,
  looksLikeBlockClipboard, parseBlockClipboard, planPackageImport, serializeBlockClipboard,
  SITE_PACKAGE_FORMAT, SITE_PACKAGE_FORMAT_VERSION, type Block, type SitePackage, type SiteStyle,
} from '../index.js';

const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 800 } };
const blocks: Block[] = [
  { id: 's', type: 'core/section', data: {}, children: [
    { id: 'h', type: 'core/rich_heading', data: { html: 'Fresh &amp; warm <em>bread</em>', level: 'h2', style_id: 'hero' } },
    { id: 'p', type: 'core/prose', data: { html: '<p>Baked daily.</p><p><img src="https://cms.example.com/api/sites/studio/media/m1/content" alt=""></p>' } },
  ] },
  { id: 'b', type: 'core/button', data: { label: 'Order "now"', url: '/order' } },
];

function pkg(contents: SitePackage['contents'] = { blocks, styles: [hero] }): SitePackage {
  return {
    format: SITE_PACKAGE_FORMAT, format_version: SITE_PACKAGE_FORMAT_VERSION, kind: 'clipboard', id: 'clipboard', name: 'Blocks from Home', version: '1',
    created_at: '2026-11-07T12:00:00.000Z', contents, media: [], integrity: { algorithm: 'sha256', files: {} },
  };
}

const clipboard = () => buildBlockClipboard({
  source: { portal: 'https://cms.example.com', site_id: 'studio', site_key: 'a'.repeat(24), page_id: 'home' },
  copied_at: '2026-11-07T12:00:00.000Z',
  package: pkg(),
  media: [{ site_id: 'studio', media_id: 'm1', addresses: ['https://cms.example.com/api/sites/studio/media/m1/content'], filename: 'loaf.png' }],
  page_links: {},
});

describe('block clipboard', () => {
  it('builds a marked clipboard with the blocks\' text and reads it back', () => {
    const value = clipboard();
    const text = serializeBlockClipboard(value);
    expect(text.startsWith('{"typeroll_clipboard":1,')).toBe(true);
    expect(value.text).toBe('Fresh & warm bread\nBaked daily.\nOrder "now"');
    expect(value).not.toHaveProperty('page_links');
    expect(looksLikeBlockClipboard(text)).toBe(true);
    expect(looksLikeBlockClipboard('Some text I copied')).toBe(false);
    expect(parseBlockClipboard(text)).toEqual(value);
    expect(parseBlockClipboard(value)).toEqual(value);
    expect(blockClipboardCount(value)).toEqual({ top: 2, total: 4 });
    expect(blockClipboardHtml(value)).toBe('<meta charset="utf-8"><div><p>Fresh &amp; warm bread</p><p>Baked daily.</p><p>Order &quot;now&quot;</p></div>');
  });

  it('refuses text that is not copied blocks, other versions, embedded media and oversize clipboards', () => {
    expect(() => parseBlockClipboard('hello')).toThrow(expect.objectContaining({ status: 400, code: 'clipboard_invalid' }));
    expect(() => parseBlockClipboard('{"typeroll_clipboard":1,')).toThrow(/not JSON/);
    expect(blockClipboardErrors({ hello: 1 })).toEqual(['This is not copied Typeroll blocks (no "typeroll_clipboard" marker)']);
    expect(blockClipboardErrors({ ...clipboard(), typeroll_clipboard: 2 })[0]).toMatch(/version 2 is not supported/);
    expect(blockClipboardErrors({ ...clipboard(), source: { site_id: '' } })).toContain('source.site_id is required');
    expect(blockClipboardErrors({ ...clipboard(), package: { ...pkg(), kind: 'collection' } })).toContain('package.kind must be "clipboard"');
    expect(blockClipboardErrors({ ...clipboard(), package: pkg({ blocks: [] }) })).toContain('package.contents.blocks must hold the copied blocks');
    expect(blockClipboardErrors({ ...clipboard(), package: pkg({ blocks, pages: [] }) })).toContain('package.contents.pages is not part of copied blocks');
    const embedded = { ...pkg(), media: [{ id: 'm', path: `media/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), bytes: 1, content_type: 'image/png', filename: 'a.png' }] };
    expect(blockClipboardErrors({ ...clipboard(), package: embedded })[0]).toMatch(/package.media must be empty/);
    expect(blockClipboardErrors({ ...clipboard(), media: [{ site_id: 'studio' }] })[0]).toMatch(/media entries/);
    // An invalid block tree is caught by the package checks.
    expect(blockClipboardErrors({ ...clipboard(), package: pkg({ blocks: [{ id: 'x', type: '' } as Block] }) })[0]).toMatch(/^package: blocks/);
    const huge = serializeBlockClipboard({ ...clipboard(), text: 'x'.repeat(BLOCK_CLIPBOARD_MAX_BYTES) });
    expect(() => parseBlockClipboard(huge)).toThrow(expect.objectContaining({ status: 413, code: 'clipboard_too_large' }));
  });

  it('reads the text of every text field in reading order', () => {
    expect(blocksPlainText([
      { id: 'a', type: 'core/faq', data: { items: [{ question: 'Open?', answer: '<p>Yes &#8212; daily</p>' }], style_id: 'faq' } },
      { id: 'c', type: 'core/columns', data: {}, slots: [[{ id: 'l', type: 'core/prose', data: { html: '<p>Left</p><script>x()</script>' } }], [{ id: 'r', type: 'core/prose', data: { html: 'Right<br>line' } }]] },
    ])).toBe('Open?\nYes — daily\nLeft\nRight\nline');
  });

  it('plans a second paste onto the copy the first one created', () => {
    const changed: SiteStyle = { ...hero, base: { weight: 300 } };
    const first = planPackageImport(pkg(), { styles: [changed], blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] }, { design: 'content' });
    expect(first.styles.map(entry => [entry.action, entry.to, entry.name])).toEqual([['rename', 'hero-2', 'Hero (imported)']]);
    const again = planPackageImport(pkg(), { styles: [changed, first.styles[0]!.style], blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] }, { design: 'content' });
    expect(again.styles.map(entry => [entry.action, entry.to])).toEqual([['reuse', 'hero-2']]);
    expect(again.maps.styles.get('hero')).toBe('hero-2');
  });
});
