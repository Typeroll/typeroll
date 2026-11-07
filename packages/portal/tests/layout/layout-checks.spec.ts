/** Each layout rule finds its defect, and a sound page passes. */
import { expect, test, type Page } from '@playwright/test';
import { measureLayout } from './layout-checks';

const page = async (browser: Page, body: string, css = '') => {
  await browser.setViewportSize({ width: 375, height: 800 });
  await browser.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><style>
    body{margin:0;font:16px/1.5 sans-serif} main{display:block} section{padding:48px 16px} footer{padding:24px 16px}
    .btn{display:inline-block;padding:12px 16px;background:#16161a;color:#fff} ${css}</style>
    <main>${body}</main><footer><p>Footer</p></footer>`);
  return (await browser.evaluate(measureLayout)).map(problem => problem.check);
};
const cta = (extra = '') => `<section class="beta" data-source-block-type="core/section" data-source-block-id="beta"><h2>Try it</h2>
  <p><a class="btn" href="/">Start a 30-day trial</a></p>${extra}</section>`;

test('a sound page passes', async ({ page: browser }) => {
  expect(await page(browser, cta())).toEqual([]);
});

test('a decorative band drawn over the buttons is found (typeroll.com, 2026-11-06)', async ({ page: browser }) => {
  const css = `.beta{position:relative;padding-bottom:150px} .beta::after{content:'';position:absolute;left:0;right:0;bottom:0;height:70px;background:#e03}
    .beta{padding-block:3rem}`;
  expect(await page(browser, cta(), css)).toContain('decoration_covers_content');
});

test('overflow, overlap, escape, clipping, small targets, footer space and unreadable text are found', async ({ page: browser }) => {
  expect(await page(browser, `<section><p style="white-space:nowrap">${'x'.repeat(80)}</p></section>`)).toContain('horizontal_overflow');
  expect(await page(browser, `<section><p>One</p><p style="margin-top:-24px">Two</p></section>`)).toContain('content_overlap');
  expect(await page(browser, `<section data-source-block-type="core/grid" data-source-block-id="g" style="width:120px">
    <div data-source-block-type="core/prose" data-source-block-id="p" style="width:300px"><p>Wide</p></div></section>`)).toContain('escapes_container');
  expect(await page(browser, `<section><div style="height:20px;overflow:hidden"><p>Line one</p><p>Line two</p></div></section>`)).toContain('clipped_text');
  expect(await page(browser, `<section><a href="/" style="display:inline-block;width:10px;height:10px"></a><a href="/">x</a></section>`)).toContain('small_touch_target');
  expect(await page(browser, `<p>Last</p>`, 'main p{margin:0} footer{padding-top:0} footer p{margin:0}')).toContain('footer_space');
  expect(await page(browser, `<section><p style="color:#fff">Invisible</p></section>`)).toContain('unreadable_text');
});

test('oversized phone headings and loose phone spacing are found', async ({ page: browser }) => {
  const section = (body: string, style = '') => `<section data-block="section" style="${style}">${body}</section>`;
  expect(await page(browser, section('<h1 style="font-size:56px;margin:0">Build a website your team keeps current</h1>'))).toContain('heading_too_large');
  expect(await page(browser, section('<h2 style="font-size:24px;margin:0">A second-level heading in the text</h2>'))).not.toContain('heading_too_large');
  expect(await page(browser, section('<h1 style="font-size:32px;margin:0">Build a website your team keeps current</h1>'))).not.toContain('heading_too_large');
  expect(await page(browser, section('<p>Text</p>', 'padding:96px 16px'))).toContain('section_padding_mobile');
  expect(await page(browser, section('<p style="margin:0">One</p><p style="margin:80px 0 0">Two</p>'))).toContain('excess_gap_mobile');
});

test('text spilling out of a badge is found', async ({ page: browser }) => {
  expect(await page(browser, `<section><span style="display:inline-flex;width:40px;height:40px;background:#16161a;color:#fff;overflow-wrap:anywhere">Step number</span></section>`)).toContain('text_spills');
  expect(await page(browser, `<section><span style="display:inline-flex;min-width:40px;height:40px;padding:0 8px;background:#16161a;color:#fff;white-space:nowrap;align-items:center">Step 1</span></section>`)).not.toContain('text_spills');
});

test('a heading in running text with as much space below as above is found', async ({ page: browser }) => {
  const text = (h2: string) => `<section data-block="section"><div data-block="prose"><p>Before</p><h2 style="${h2}">A heading</h2><p>After</p></div></section>`;
  expect(await page(browser, text('margin:24px 0'))).toContain('heading_spacing');
  expect(await page(browser, text('margin:24px 0 12px'))).toContain('heading_spacing');
  expect(await page(browser, text('margin:40px 0 12px'))).not.toContain('heading_spacing');
});

test('links in running text, closed panels, icons in a field and a coloured last section pass', async ({ page: browser }) => {
  expect(await page(browser, `<section><p>Read <a href="/">the guide</a> first.</p>
    <details><summary class="btn">Open</summary><p>Hidden</p><p>Hidden too</p></details>
    <form style="position:relative"><input style="padding:12px 12px 12px 40px;width:200px;font-size:16px" value="Search"><span style="position:absolute;left:12px;top:14px;width:16px;height:16px;background:#888"></span></form></section>
    <section style="background:#eef">${'<p>Last</p>'}</section>`, 'main > section:last-child{padding-bottom:0}')).toEqual([]);
});

test('content edges that differ between blocks of the same width are found (finding 9)', async ({ page: browser }) => {
  const edges = async (frowWidth: string) => {
    await browser.setViewportSize({ width: 1440, height: 800 });
    await browser.setContent(`<!doctype html><style>body{margin:0;font:16px/1.5 sans-serif} .page-content--blocks>*{box-sizing:border-box;margin-inline:auto;padding:24px 28px}
      .block-section-inner,.block-frow-inner{margin-inline:auto}</style>
      <main class="page-content--blocks">
        <section data-block="section" data-width="normal"><div class="block-section-inner" style="max-width:1040px"><p>Section</p></div></section>
        <section data-block="feature_row" data-width="normal" style="max-width:1096px"><div class="block-frow-inner" style="max-width:${frowWidth}"><p>Row</p></div></section>
      </main>`);
    return (await browser.evaluate(measureLayout)).map(problem => problem.check);
  };
  expect(await edges('1040px')).not.toContain('content_edge');
  expect(await edges('900px')).toContain('content_edge');
});
