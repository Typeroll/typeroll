/**
 * Render version 7: options core blocks declared and never rendered.
 *
 * The carousel's arrows, dots and autoplay, a hero's background video and its
 * pause button, video embeds and required choice groups, each through the
 * published sanitizer and block runtime.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  FORMS_RUNTIME_JS,
  buildCoreBlockRegistry,
  collectBlockAssets,
  renderBlocks,
  renderFormHtml,
  type Block,
} from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';

const registry = buildCoreBlockRegistry();
const reset = fs.readFileSync(new URL('../../../site-template/src/styles/reset.css', import.meta.url), 'utf8');
const blocksRuntime = (js: string) =>
  `(function(){var registry={};window.TyperollBlocks={register:function(id,init){registry[id]=init;},init:function(){Object.keys(registry).forEach(function(id){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(function(el){registry[id](el);});});}};${js};window.TyperollBlocks.init();})();`;

async function open(page: Page, blocks: Block[], extra = '') {
  const assets = collectBlockAssets(blocks, registry, { renderVersion: 7 });
  const body = sanitizeBody(renderBlocks(blocks, { registry, renderVersion: 7 }));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>${reset}body{margin:0;padding:16px}${assets.css}</style><body>${body}${extra}<script>${blocksRuntime(assets.js)}</script></body></html>`;
  await page.route('https://site.test/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.route('https://site.test/media/**', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('https://site.test/');
}

const testimonials = (data: Record<string, unknown> = {}): Block => ({
  id: 'quotes', type: 'core/testimonials',
  data: { cols: 1, items: Array.from({ length: 5 }, (_, i) => ({ quote: `<p>Quote ${i + 1}</p>`, name: `Person ${i + 1}`, rating: 4 })), ...data },
});
const scrollIndex = (page: Page) => page.locator('.tr-carousel-track').evaluate(track => Math.round(track.scrollLeft / track.clientWidth));

test.describe('carousel', () => {
  test.use({ viewport: { width: 800, height: 700 } });

  test('arrows and dots move between items and say where the visitor is', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, [testimonials()]);
    const controls = page.locator('.tr-carousel-controls');
    await expect(controls).toBeVisible();
    await expect(page.getByRole('region', { name: 'Carousel' })).toBeVisible();
    const previous = page.getByRole('button', { name: 'Previous' });
    const next = page.getByRole('button', { name: 'Next' });
    await expect(previous).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Show item 1' })).toHaveAttribute('aria-current', 'true');

    await next.click();
    await expect.poll(() => scrollIndex(page)).toBe(1);
    await expect(page.getByRole('button', { name: 'Show item 2' })).toHaveAttribute('aria-current', 'true');
    await expect(previous).toBeEnabled();

    await page.getByRole('button', { name: 'Show item 5' }).click();
    await expect.poll(() => scrollIndex(page)).toBe(4);
    await expect(next).toBeDisabled();

    // Keyboard: the controls are ordinary buttons.
    await previous.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => scrollIndex(page)).toBe(3);
    await expect(page.getByRole('img', { name: 'Rating: 4 out of 5' }).first()).toBeVisible();
  });

  test('autoplay advances, pauses on hover and on the pause button', async ({ page }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, [testimonials({ autoplay: true })]);
    await page.mouse.move(790, 690);
    await page.clock.runFor(5100);
    await expect.poll(() => scrollIndex(page)).toBe(1);

    await page.locator('.tr-carousel-track').hover();
    await page.clock.runFor(10_200);
    expect(await scrollIndex(page)).toBe(1);

    await page.mouse.move(790, 690);
    const pause = page.getByRole('button', { name: 'Pause' });
    await pause.click();
    await page.mouse.move(790, 690);
    await page.locator('body').click({ position: { x: 790, y: 690 } });
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await page.clock.runFor(10_200);
    expect(await scrollIndex(page)).toBe(1);
  });

  test('autoplay never runs when the visitor prefers reduced motion', async ({ page }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, [testimonials({ autoplay: true })]);
    await expect(page.locator('[data-carousel-pause]')).toBeHidden();
    await page.mouse.move(790, 690);
    await page.clock.runFor(10_200);
    expect(await scrollIndex(page)).toBe(0);
  });
});

test.describe('hero background video', () => {
  const hero: Block = { id: 'hero', type: 'core/hero', data: { heading: 'Moving made easy', video_url: '/media/loop.mp4', image: '/media/still.jpg', layout: 'full-image' } };

  test('has a pause button that changes its name', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, [hero]);
    const video = page.locator('video.block-hero-video');
    await expect(video).toHaveAttribute('poster', '/media/still.jpg');
    const toggle = page.locator('.block-hero-video-toggle');
    await expect(toggle).toBeVisible();
    // The test file never loads, so the video stays paused; the button
    // offers whatever the video's state calls for.
    await video.evaluate((element: HTMLVideoElement) => { Object.defineProperty(element, 'paused', { value: false, configurable: true }); element.pause = () => { Object.defineProperty(element, 'paused', { value: true, configurable: true }); }; });
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Play video');
  });

  test('stays still when the visitor prefers reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, [hero]);
    await expect(page.locator('video.block-hero-video')).toBeHidden();
    await expect(page.locator('.block-hero-video-toggle')).toBeHidden();
    expect(await page.locator('video.block-hero-video').evaluate(element => element.hasAttribute('autoplay'))).toBe(false);
  });
});

test('a YouTube address survives the published sanitizer as a no-cookie embed', () => {
  const html = sanitizeBody(renderBlocks([{ id: 'v', type: 'core/video', data: { video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Tour' } }], { registry, renderVersion: 7 }));
  expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&amp;playsinline=1" title="Tour" loading="lazy"');
});

test('a required checkbox group needs one checked box before the browser submits', async ({ page }) => {
  const form = renderFormHtml({
    id: 'f', name: 'Topics', submit_text: 'Send',
    steps: [{ id: 's', blocks: [{ id: 'g', type: 'form/checkbox_group', data: { name: 'topics', label: 'Topics', required: true, choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } }] }],
  } as never, { submit_url: 'https://site.test/submit', submit_token: 't', preview: true }, { registry, renderVersion: 7 });
  await open(page, [], `${form}<script>${FORMS_RUNTIME_JS}</script>`);
  const valid = () => page.locator('form').evaluate((element: HTMLFormElement) => element.checkValidity());
  await expect.poll(valid).toBe(false);
  await page.getByLabel('B').check();
  expect(await valid()).toBe(true);
  await page.getByLabel('B').uncheck();
  expect(await valid()).toBe(false);
});
