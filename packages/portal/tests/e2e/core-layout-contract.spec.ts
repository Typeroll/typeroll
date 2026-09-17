import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, CONTENT_WELL_CSS, renderBlocks, type Block } from '@typeroll/shared';
const registry = buildCoreBlockRegistry();
const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#d5edf3"/><rect x="5" y="5" width="790" height="390" fill="none" stroke="#163e52" stroke-width="10"/><circle cx="400" cy="200" r="120" fill="#fbb86b"/></svg>').toString('base64');
const blocks: Block[] = [
  { id: 'hero', type: 'core/hero', data: { heading: 'All of the picture', subheading: '<p>Responsive native defaults</p>', image, layout: 'split-left', background: '#eaf3f8' } },
  { id: 'section', type: 'core/section', data: { background: '#faf1df' }, children: [
    { id: 'crumbs', type: 'template/page_breadcrumbs', data: {} },
    { id: 'heading', type: 'core/heading', data: { text: 'A readable heading', level: 'h2' } },
    { id: 'image', type: 'core/image', data: { src: image, alt: 'Whole picture' } },
    { id: 'facts', type: 'core/field_list', data: { fields: [{ field: 'features', item_html: '<span aria-hidden="true">☑</span> {{value}}' }] } },
    { id: 'list', type: 'core/list', data: { marker: 'check', items: [{ html: 'One marker per row' }] } },
  ] },
];
function html(tree: Block[]) {
  return `<!doctype html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box;margin:0}body{font:16px Arial}img{display:block;max-width:100%}:root{--container-medium:1080px}${CONTENT_WELL_CSS}${collectBlockAssets(tree, registry).css}</style><main class="page-content page-content--blocks">${renderBlocks(tree, { registry, context: { page: { title: 'Example', fields: { features: ['fast', 'flexible'] } }, content_type: { fields: [{ name: 'features', type: 'multiselect', options: ['fast', 'flexible'], option_labels: ['Fast', 'Flexible'] }] }, breadcrumbs: [{ label: 'Home', href: '/' }] } })}</main>`;
}
test('native typography, intrinsic images, full-bleed backgrounds and single markers at all target widths', async ({ page }, info) => {
  await page.setContent(html(blocks));
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    for (const type of ['hero', 'section']) {
      const box = await page.locator(`[data-block="${type}"]`).boundingBox();
      expect(box!.x).toBe(0); expect(box!.width).toBe(width);
    }
    const section = page.locator('[data-block="section"]');
    expect(await section.evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBe(width === 375 ? 48 : width === 768 ? 64 : 80);
    expect(await section.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBe(width === 375 ? 20 : 28);
    const headingBox = await page.locator('[data-block="heading"]').boundingBox();
    const imageBox = await page.locator('[data-block="image"]').boundingBox();
    expect(imageBox!.y - headingBox!.y - headingBox!.height).toBe(width === 1280 ? 32 : 24);
    // Select by block structure; renderer IDs are an implementation detail.
    expect(await page.locator('[data-block="heading"] h2').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(width === 375 ? 22 : 24);
    expect(await page.locator('[data-block="heading"] h2').evaluate(el => parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize))).toBe(1.25);
    for (const selector of ['.block-hero-media img', '[data-block="image"] img']) {
      const result = await page.locator(selector).evaluate(el => ({ fit: getComputedStyle(el).objectFit, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
      expect(result.fit).toBe('contain'); expect(result.width / result.height).toBeCloseTo(2, 1);
    }
    expect(await page.locator('.field-list-values').evaluate(el => getComputedStyle(el).listStyleType)).toBe('none');
    expect(await page.locator('[data-block="list"] ul').evaluate(el => getComputedStyle(el).listStyleType)).toBe('none');
    expect(await page.locator('[data-block="list"] li').evaluate(el => getComputedStyle(el, '::before').content)).toContain('✓');
    expect(await page.locator('[data-block="breadcrumbs"]').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom))).toBe(width === 1280 ? 40 : 32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`core-defaults-${width}.png`), fullPage: true });
  }
});
test('navigation uses one shared 1024px boundary and preserves keyboard behavior across resize', async ({ page }) => {
  await page.setContent(html([{ id: 'nav', type: 'core/navigation', data: { links: [{ label: 'Home', href: '/' }] } }]));
  await page.addScriptTag({ content: `window.TyperollBlocks={register(name,init){document.querySelectorAll('[data-block="navigation"]').forEach(init)}};${registry.get('core/navigation')!.script}` });
  const button = page.locator('.block-navigation-toggle'), links = page.locator('.block-navigation-list');
  for (const width of [375, 768, 1023, 1024, 1280, 1023]) {
    await page.setViewportSize({ width, height: 600 });
    if (width < 1024) {
      await expect(button).toBeVisible(); await expect(links).toBeHidden();
      await button.click(); await expect(links).toBeVisible();
      await page.keyboard.press('Escape'); await expect(links).toBeHidden(); await expect(button).toBeFocused();
    } else { await expect(button).toBeHidden(); await expect(links).toBeVisible(); }
  }
});
test('explicit image crop and theme tokens remain author controlled', async ({ page }) => {
  await page.setContent(html([{ id: 'crop', type: 'core/image', data: { src: image, fit: 'cover', aspect_ratio: '1:1' } }]));
  await page.setViewportSize({ width: 375, height: 700 });
  const box = await page.locator('img').boundingBox(); expect(box!.width).toBeCloseTo(box!.height, 1);
  expect(await page.locator('img').evaluate(el => getComputedStyle(el).objectFit)).toBe('cover');
  await page.setContent(html(blocks) + '<style>:root{--section-padding:12px;--type-h2:30px}</style>');
  expect(await page.locator('[data-block="section"]').evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBe(12);
  expect(await page.locator('[data-block="heading"] h2').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(30);
});

test('automatic heading levels never invert the hierarchy at any target width', async ({ page }) => {
  await page.setContent(html([1, 2, 3, 4, 5, 6].map(level => ({ id: `h${level}`, type: 'core/heading', data: { text: `Heading ${level}`, level: `h${level}` } }))));
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    const sizes = await page.locator('.block-heading-text').evaluateAll(elements => elements.map(el => parseFloat(getComputedStyle(el).fontSize)));
    for (let index = 1; index < sizes.length; index++) expect(sizes[index]).toBeLessThanOrEqual(sizes[index - 1]);
  }
});
