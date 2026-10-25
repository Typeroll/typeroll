// Isolated QA browser only. Never persist storage state, cookies or signed URLs.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Select only Typeroll's own preview, never an arbitrary ad/video iframe.
  const frame = page.locator('iframe[title="Preview"], iframe[title="Site preview"]');
  if (await frame.count() === 1) {
    await page.waitForFunction(() => document.querySelector('iframe[title="Preview"], iframe[title="Site preview"]')?.getAttribute('src'), null, { timeout: 15000 });
    const src = await frame.getAttribute('src');
    if (!src) throw Error('Preview frame has no source');
    const target = new URL(src, page.url());
    if (target.origin !== new URL(page.url()).origin) throw Error('Unexpected preview frame origin');
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.evaluate(() => document.fonts.ready);
}
async function settle(page) {
  // Bounded for infinite-scroll pages; report coverage rather than hanging.
  for (let y = 0; y < 30000; y += 600) {
    await page.evaluate(y => scrollTo(0, y), y);
    await page.waitForTimeout(100);
    if (y + 900 >= await page.evaluate(() => document.documentElement.scrollHeight)) break;
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
}
async function inspect(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    h1: document.querySelectorAll('h1').length,
    title: document.title,
    robots: document.querySelector('meta[name="robots"]')?.content ?? null,
    fonts: { body: getComputedStyle(document.body).fontFamily, heading: getComputedStyle(document.querySelector('h1') || document.body).fontFamily },
    incompleteImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => new URL(i.currentSrc || i.src, location.href).pathname),
    scrollCoverageComplete: document.documentElement.scrollHeight <= 30000,
  }));
}
async function screenshot(page, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}
function widths(args) {
  const values = (args.length ? args : ['390', '768', '1023', '1024', '1280']).map(Number);
  if (values.some(w => !Number.isInteger(w) || w < 240 || w > 4000)) throw Error('Invalid viewport width');
  return values;
}
function fail() { console.error('QA failed; inspect the target privately. URLs and credentials are withheld.'); process.exitCode = 2; }
module.exports = { chromium, open, settle, inspect, screenshot, widths, fail };
