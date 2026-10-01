import type { Page, Response } from '@playwright/test';

/**
 * Explicit readiness for portal pages, instead of `waitUntil: 'networkidle'`.
 *
 * The editors never promise an idle network: previews reload after edits,
 * preview iframes and the app shell fetch web fonts from an external host,
 * and status panels refresh. One slow or stalled request makes networkidle
 * (and even the `load` event, which waits for iframes) time out, while the
 * page a test drives is long ready. What a test needs is that the React
 * islands handle input and that the layout has its final fonts.
 */

/**
 * Every Astro island has hydrated. Astro removes an island's `ssr` attribute
 * when it hands the island to React (portal islands are all client:load),
 * and React marks hydrated DOM nodes with its fiber key. Input before that
 * point can be dropped: React re-applies the server-rendered value.
 */
export async function waitForHydration(page: Page, timeout = 30_000): Promise<void> {
  // Past `loading`, every island is in the DOM, so none can be missed.
  await page.waitForFunction(() => document.readyState !== 'loading' && [...document.querySelectorAll('astro-island')].every(island => {
    if (island.hasAttribute('ssr')) return false;
    const root = island.firstElementChild;
    return !root || root.localName === 'template' || Object.keys(root).some(key => key.startsWith('__reactFiber$'));
  }), undefined, { timeout });
  // Web fonts change text metrics, which layout assertions depend on. Cap
  // the wait so a stalled external font request cannot hang the test.
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 5_000))]));
}

/** Navigate and wait until the page is interactive (see waitForHydration). */
export async function gotoReady(page: Page, url: string): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  return response;
}

/** Reload and wait until the page is interactive (see waitForHydration). */
export async function reloadReady(page: Page): Promise<Response | null> {
  const response = await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  return response;
}
