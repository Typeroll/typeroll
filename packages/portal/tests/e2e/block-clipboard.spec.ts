/**
 * Copy and paste of blocks between sites of one organization (dev session):
 *   - Cmd/Ctrl+C on a selected block in one site's page puts copied blocks on
 *     the system clipboard (JSON with the typeroll_clipboard marker)
 *   - Cmd/Ctrl+V on another site's page pastes it after the selected block
 *   - the target site has a different "hero" style, so the pasted heading
 *     gets the style created as "Hero (imported)" instead of being mapped
 */
import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { PORTAL_ORIGIN, e2eStore } from './helpers/store';

const SOURCE = 'organizations/default/sites/e2e-clip-source';
const TARGET = 'organizations/default/sites/e2e-clip-target';
const site = (name: string) => ({ name, hosting_adapter: 'cloudflare', publishing_mode: 'customer_git', status: 'live', created_at: '2026-01-01T00:00:00.000Z', staging_url: null });
const settings = (name: string, weight: number) => ({
  site_name: name, colors: { primary: '#3b82f6', background: '#ffffff', text: '#0f172a' },
  styles: [{ id: 'hero', name: 'Hero', targets: ['heading'], base: { weight } }],
});

test('copy a block with Cmd/Ctrl+C on one site and paste it with Cmd/Ctrl+V on another', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are granted in Chromium only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PORTAL_ORIGIN });
  await e2eStore.setMany([
    [SOURCE, site('Clipboard source')],
    [`${SOURCE}/versions/main/settings/default`, settings('Clipboard source', 800)],
    [`${SOURCE}/versions/main/pages/source`, { id: 'source', title: 'Source', slug: 'source', status: 'draft', content_mode: 'blocks', blocks: [
      { id: 'hero-heading', name: 'Hero heading', type: 'core/rich_heading', data: { html: 'Fresh bread', level: 'h2', style_id: 'hero' } },
    ] }],
    [TARGET, site('Clipboard target')],
    [`${TARGET}/versions/main/settings/default`, settings('Clipboard target', 300)],
    [`${TARGET}/versions/main/pages/target`, { id: 'target', title: 'Target', slug: 'target', status: 'draft', content_mode: 'blocks', blocks: [
      { id: 'existing', name: 'Existing text', type: 'core/prose', data: { html: '<p>Already here.</p>' } },
    ] }],
  ]);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoReady(page, '/app/sites/e2e-clip-source/pages/source');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Hero heading', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect(page.getByRole('status').filter({ hasText: 'Copied 1 block' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith('{"typeroll_clipboard":1,')).toBe(true);

    await gotoReady(page, '/app/sites/e2e-clip-target/pages/target');
    await page.getByRole('button', { name: 'Structure', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Existing text', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByRole('status').filter({ hasText: 'Pasted 1 block; created the style Hero (imported)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Hero heading', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('block-clipboard-pasted.png') });

    const blocks = (await (await page.request.get('/api/sites/e2e-clip-target/pages/target/blocks')).json()).blocks as Array<{ id: string; type: string; data: Record<string, unknown> }>;
    expect(blocks.map(block => block.type)).toEqual(['core/prose', 'core/rich_heading']);
    expect(blocks[1]!.id).not.toBe('hero-heading');
    expect(blocks[1]!.data.style_id).toBe('hero-2');
    const styles = (await e2eStore.read(`${TARGET}/versions/main/settings/default`)).styles as Array<{ id: string; name: string; base: Record<string, unknown> }>;
    expect(styles.map(style => [style.id, style.name])).toEqual([['hero', 'Hero'], ['hero-2', 'Hero (imported)']]);
    expect(styles[0]!.base).toEqual({ weight: 300 });
  } finally {
    for (const [siteId, pageId] of [['e2e-clip-source', 'source'], ['e2e-clip-target', 'target']]) {
      await page.request.delete(`/api/sites/${siteId}/working-copy/page/${pageId}`, { headers: { Origin: PORTAL_ORIGIN } });
    }
    await e2eStore.deleteTree(SOURCE, TARGET);
  }
});
