/**
 * A container's children stay inside a 375px screen when one of them holds a
 * long word, an address or inline code (render version 13). A wrapping column
 * flex container sized its line to the widest child's min-content width, so
 * one such child made every child, and the page, scroll sideways.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { BLOCKS_RUNTIME_CSS, buildCoreBlockRegistry, collectBlockAssets, contentWellCss, defaultSiteSettings, newSiteStyles, renderBlocks, resolveBreakpointWidths, siteStylesCss, siteThemeCss, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const siteCss = (name: string) => fs.readFileSync(new URL(`../../../site-template/src/styles/${name}`, import.meta.url), 'utf8');
const WORD = 'Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung';
const CODE = '<code>npm&nbsp;run&nbsp;-s&nbsp;cloud:release&nbsp;--&nbsp;--pr&nbsp;129&nbsp;--production</code>';
const URL_TEXT = 'https://typeroll.com/docs/getting-started/agent-workspace/configuration-reference/';

const intro = (data: Record<string, unknown> = {}): Block => ({ id: 'intro', type: 'core/container', data: { width: 'full', gap: 'none', ...data }, children: [
  { id: 'eyebrow', type: 'core/prose', data: { html: `<p>${WORD}</p>`, max_width: 'full' } },
  { id: 'title', type: 'core/heading', data: { text: `Heading ${WORD}`, level: 'h2', size: 'theme' } },
  { id: 'lead', type: 'core/prose', data: { html: `<p>Run ${CODE} or read ${URL_TEXT}</p><h3>${WORD}</h3><ul><li>${WORD}</li></ul>` } },
  { id: 'rich', type: 'core/rich_heading', data: { level: 'h3', html: `Rich ${CODE}` } },
  { id: 'action', type: 'core/button', data: { label: WORD, href: '/start/' } },
] });
const section = (children: Block[]): Block => ({ id: 'section', type: 'core/section', data: { width: 'wide', padding_y: 'none' }, children });

async function open(page: Page, blocks: Block[], renderVersion: number) {
  const settings = { ...structuredClone(defaultSiteSettings), render_version: renderVersion, styles: newSiteStyles() };
  const css = siteCss('reset.css') + siteCss('global.css') + BLOCKS_RUNTIME_CSS + contentWellCss(renderVersion)
    + collectBlockAssets(blocks, registry, { renderVersion }).css + siteThemeCss(settings)
    + siteStylesCss(settings.styles, { colors: settings.colors, breakpoints: resolveBreakpointWidths(), renderVersion });
  await page.setContent(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style><main class="page-content page-content--blocks">${renderBlocks(blocks, { registry, renderVersion })}</main>`);
}
const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

test('container children with long words fit a 375px screen from render version 13', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const layouts: Record<string, Block[]> = {
    'section intro': [section([intro()])],
    'nested normal-width container': [section([{ id: 'outer', type: 'core/container', data: { width: 'full' }, children: [intro({ width: 'normal' })] }])],
    'children aligned to the start': [section([intro({ align_cross: 'start' })])],
    'children centred': [section([intro({ align_cross: 'center' })])],
    'column inside a row that does not wrap': [section([{ id: 'row', type: 'core/container', data: { width: 'full', direction: 'row', wrap: 'nowrap' }, children: [intro()] }])],
  };
  for (const [name, blocks] of Object.entries(layouts)) {
    await open(page, blocks, 12);
    // The defect this version fixes: the page scrolls sideways.
    expect(await scrollWidth(page), `${name} at render version 12`).toBeGreaterThan(375);
    await open(page, blocks, 13);
    expect(await scrollWidth(page), name).toBeLessThanOrEqual(375);
    const overflowing = await page.evaluate(() => [...document.querySelectorAll('[data-block="section"] *')]
      .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth - 19)
      .map(element => element.outerHTML.slice(0, 80)));
    expect(overflowing, name).toEqual([]);
  }
  await open(page, layouts['section intro']!, 13);
  await page.screenshot({ path: testInfo.outputPath('section-intro-375.png'), fullPage: true });
});

test('rows with fixed-width children lay out as before', async ({ page }) => {
  const fixed = (id: string): Block => ({ id, type: 'core/container', data: { width: 'full', inline_style: 'flex:0 0 240px' }, children: [{ id: `${id}-text`, type: 'core/prose', data: { html: '<p>Fixed column</p>' } }] });
  const blocks = [section([
    { id: 'nowrap', type: 'core/container', data: { width: 'full', direction: 'row', wrap: 'nowrap' }, children: [fixed('a'), fixed('b'), fixed('c')] },
    { id: 'wrap', type: 'core/container', data: { width: 'full', direction: 'row' }, children: [fixed('d'), fixed('e'), fixed('f')] },
  ])];
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = async () => page.locator('[data-block="container"]').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map(Math.round);
    }));
    await open(page, blocks, 12);
    const before = await boxes();
    await open(page, blocks, 13);
    expect(await boxes(), `${width}px`).toEqual(before);
  }
});
