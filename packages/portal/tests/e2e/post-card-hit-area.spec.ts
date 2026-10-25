import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const card: Block = { id: 'card', type: 'core/post_card', data: { title: 'Island guide', href: '#destination', excerpt: 'Explore the island and its places to stay.', whole_card_link: true, appearance: 'card', background: '#EEF5FD', show_image: false, show_date: false } };
for (const width of [390, 768, 1280]) {
  test(`whole-card excerpt is readable and clickable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const blocks: Block[] = [card, { id: 'repeater', type: 'core/repeater', data: { item_block: 'core/post_card', items: [{ title: 'Repeated guide', url: '#destination', excerpt: 'An equally accessible repeated card.' }], item_overrides: { ...card.data } } }];
    await page.setContent(`<style>body{font:16px/1.5 sans-serif;color:#46556a;background:white}main{max-width:600px;margin:auto}${collectBlockAssets(blocks, registry).css}</style><main>${renderBlocks(blocks,{registry})}</main><div id="destination">Destination</div>`);
    for (const excerpt of await page.locator('.block-postcard-excerpt').all()) {
      await expect(excerpt).toHaveCSS('opacity', '1');
      const contrast = await excerpt.evaluate(el => {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0,3).map(Number);
        const luminance = (value: string) => rgb(value).map(n => { const v=n/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4; }).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);
        const a=luminance(getComputedStyle(el).color), b=luminance(getComputedStyle(el.closest('article')!).backgroundColor);
        return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      await excerpt.scrollIntoViewIfNeeded();
      const box = (await excerpt.boundingBox())!;
      expect(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.closest('a')?.getAttribute('href'), {x:box.x+box.width/2,y:box.y+box.height/2})).toBe('#destination');
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
      expect(await page.evaluate(()=>location.hash)).toBe('#destination');
      await page.evaluate(()=>location.hash = 'reset');
    }
    await page.screenshot({path:info.outputPath(`cards-${width}.png`), fullPage:true});
  });
}
