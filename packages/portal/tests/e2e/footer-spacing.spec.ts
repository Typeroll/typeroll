import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_MAIN, e2eStore, PORTAL_ORIGIN } from './helpers/store';

test('shared footer spacing persists and the editor explains a zero-space ending', async ({ page }, info) => {
  page.on('dialog', dialog => dialog.accept());
  const settingsDoc = `${DEFAULT_MAIN}/settings/default`, id = 'footer-spacing-qa', pageDoc = `${DEFAULT_MAIN}/pages/${id}`;
  const wc = `/api/sites/default/working-copy/page/${id}`;
  const original = await e2eStore.read(settingsDoc);
  try {
    await gotoReady(page, '/app/sites/default/settings?section=design');
    await page.locator('#setting-footer-spacing-mobile').fill('lg');
    await page.locator('#setting-footer-spacing-laptop').fill('xl');
    await page.getByRole('button', { name: 'Save Design', exact: true }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    expect((await e2eStore.read(settingsDoc)).footer_spacing).toEqual({ mobile: 'lg', laptop: 'xl' });
    await page.reload();
    await expect(page.locator('#setting-footer-spacing-mobile')).toHaveValue('lg');
    await page.setViewportSize({ width: 375, height: 844 });
    await gotoReady(page, '/app/sites/default/settings?section=design');
    const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Space before the footer', exact: true }) });
    await card.screenshot({ path: info.outputPath('footer-settings-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await e2eStore.set(pageDoc, { id, title: 'Quote page', slug: id, path: `/${id}/`, status: 'draft', content_mode: 'blocks', blocks: [
      { id: 'end', type: 'core/container', data: { padding_bottom_px: 0 }, children: [{ id: 'copy', type: 'core/prose', data: { html: '<p>Request a quote.</p>' } }] },
    ] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/app/sites/default/pages/${id}`);
    await page.getByRole('button', { name: 'Page settings', exact: true }).click();
    // An explicit auto choice is a layout edit and must reveal the accidental zero.
    const edge = page.getByLabel('Meet the footer edge to edge');
    await edge.check(); await edge.uncheck();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[data-layout-warnings]')).toContainText('Saved — check page spacing');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 844 });
    await page.locator('[data-layout-warnings]').screenshot({ path: info.outputPath('footer-warning-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await edge.check();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[data-layout-warnings]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    expect((await e2eStore.read(pageDoc)).footer_spacing).toBe('none');
  } finally {
    await page.goto('about:blank');
    await page.request.delete(wc, { headers: { Origin: PORTAL_ORIGIN } });
    await e2eStore.deleteTree(pageDoc);
    await e2eStore.set(settingsDoc, original);
  }
});
