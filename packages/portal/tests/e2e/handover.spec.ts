/**
 * Handing a site over: the owner locks the structure of the Core persona
 * site and sets a start page and a checklist through the settings route,
 * then the editor persona (no design rights) sees the start view on the
 * overview, opens the start page's editor, is not offered adding, deleting
 * or moving blocks, and still saves a text change. The server refuses the
 * structural write the UI no longer offers.
 */
import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';
import { gotoReady } from './helpers/ready';
import { CORE_MAIN, PORTAL_ORIGIN, e2eStore } from './helpers/store';

const SITE = 'e2e-core-site';
const PAGE = 'e2e-handover';
const SETTINGS = `${CORE_MAIN}/settings/default`;
const headers = { Origin: PORTAL_ORIGIN };

test('an editor of a handed-over site edits text but not the structure', async ({ page }, info) => {
  const original = await e2eStore.get(SETTINGS);
  await e2eStore.set(`${CORE_MAIN}/pages/${PAGE}`, {
    id: PAGE, title: 'Welcome page', slug: PAGE, status: 'draft', content_type: 'page', content_mode: 'blocks',
    blocks: [{ id: 'greeting', name: 'Greeting', type: 'core/text', data: { text: 'Hello from the agency' } }],
  });
  try {
    // The owner (design rights) hands the site over.
    await authenticatePersona(page, 'owner');
    const handover = { lock_structure: true, start_page: PAGE, checklist: [
      { id: 'photos', label: 'Replace the sample photos' },
      { id: 'domain', label: 'Connect the domain', done: true },
    ] };
    const saved = await page.request.patch(`/api/sites/${SITE}/settings`, { headers, data: { handover } });
    expect(saved.status()).toBe(200);
    await gotoReady(page, `/app/sites/${SITE}`);
    await expect(page.locator('[data-handover-card]')).toContainText('1 of 2 done');
    await expect(page.locator('[data-handover-start]')).toHaveCount(0);

    // The editor sees the start view first.
    await page.context().clearCookies();
    await authenticatePersona(page, 'editor');
    await gotoReady(page, `/app/sites/${SITE}`);
    const start = page.locator('[data-handover-start]');
    await expect(start).toBeVisible();
    await expect(start).toContainText('1 of 2 done');
    await expect(start).toContainText("The site's structure is locked; you can edit text and images.");
    await page.screenshot({ path: info.outputPath('handover-start-view.png') });

    // The start page's editor: no Add tab, no structural buttons, text still saves.
    await start.locator('[data-handover-start-page]').click();
    await page.waitForURL(`**/app/sites/${SITE}/pages/${PAGE}`);
    await gotoReady(page, `/app/sites/${SITE}/pages/${PAGE}`);
    await expect(page.locator('[data-structure-locked]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(page.locator('.block-editor__tree-row [title="Delete"], .block-editor__tree-row [title^="Duplicate"], .block-editor__tree-row [title="Drag to move"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit Greeting', exact: true }).click();
    const text = page.getByLabel('Text', { exact: true });
    await text.fill('Hello from the client');
    await text.blur();
    await expect.poll(async () => {
      const draft = await (await page.request.get(`/api/sites/${SITE}/pages/${PAGE}/blocks`)).json() as { blocks: Array<{ data: { text?: string } }> };
      return draft.blocks.map(block => block.data.text);
    }, { timeout: 15_000 }).toEqual(['Hello from the client']);
    await page.screenshot({ path: info.outputPath('handover-locked-editor.png') });

    // The route refuses what the UI no longer offers.
    const refused = await page.request.post(`/api/sites/${SITE}/pages/${PAGE}/blocks`, { headers, data: { block: { type: 'core/text', data: { text: 'Extra' } } } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('structure_locked');
    await expect(page.request.post(`/api/sites/${SITE}/pages/create`, { headers, form: { title: 'Another page' } }).then(res => res.status())).resolves.toBe(403);
  } finally {
    await page.request.delete(`/api/sites/${SITE}/working-copy/page/${PAGE}`, { headers }).catch(() => {});
    await e2eStore.deleteTree(`${CORE_MAIN}/pages/${PAGE}`);
    if (original) await e2eStore.set(SETTINGS, original); else await e2eStore.delete(SETTINGS);
  }
});
