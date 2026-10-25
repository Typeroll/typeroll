import { test, expect } from '@playwright/test';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
const registry = buildCoreBlockRegistry();
for (const width of [375, 639, 640, 767, 768, 1279, 1280]) {
  test(`migration controls render at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width,height:900});
    const blocks: Block[] = [
      {id:'section',type:'core/section',data:{padding_y:{mobile:'sm',tablet:'lg'},padding_x:'sm'},children:[
        {id:'columns',type:'core/columns',data:{ratio:'1-1',content_gap_px:24},slots:[[
          {id:'one',type:'core/heading',data:{text:'Island life',level:'h2'}},
          {id:'two',type:'core/prose',data:{html:'<p>A second block with room to breathe.</p>'}},
        ],[{id:'image',type:'core/image',data:{src:'https://fixture.example/small.svg',never_upscale:true,alt:'Small blue square'}}]]},
      ]},
      {id:'hero',type:'core/hero',data:{layout:'full-image',heading:'Visit the island',height:'half-screen',image:'https://fixture.example/panorama.svg',focal_x:25,focal_y:75,overlay_opacity:30,text_vertical:'end',text_align:'end'}},
    ];
    await page.route('https://fixture.example/**',route => route.fulfill({contentType:'image/svg+xml',body:route.request().url().endsWith('/small.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="blue"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><rect width="1200" height="400" fill="#286854"/></svg>'}));
    const assets=collectBlockAssets(blocks,registry,{renderVersion:9});
    await page.setContent(`<style>body{margin:0;font:16px/1.5 sans-serif}h2,p{margin:0}${assets.css}</style>${sanitizeBody(renderBlocks(blocks,{registry,renderVersion:9}))}`);
    await expect(page.locator('[data-block="section"]')).toHaveCSS('padding-top', width >= 640 ? '96px' : '32px');
    await expect(page.locator('.block-columns-col').first()).toHaveCSS('gap','24px');
    await expect(page.locator('[data-block="image"] img')).toHaveJSProperty('naturalWidth',80);
    expect((await page.locator('[data-block="image"] img').boundingBox())!.width).toBeLessThanOrEqual(80);
    await expect(page.locator('[data-block="hero"]')).toHaveCSS('background-position','25% 75%');
    await expect(page.locator('[data-block="hero"]')).toHaveCSS('align-items','end');
    await expect(page.locator('.block-hero-text')).toHaveCSS('text-align','end');
    await expect(page.locator('.block-hero-heading')).toHaveCSS('color','rgb(255, 255, 255)');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:info.outputPath(`migration-design-${width}.png`),fullPage:true});
  });
}

test('video facade connects only after keyboard activation', async ({page}) => {
  const blocks: Block[] = [{id:'video',type:'core/video',data:{video_url:'https://youtu.be/dQw4w9WgXcQ',title:'Island film',click_to_load:true}}];
  const assets=collectBlockAssets(blocks,registry,{renderVersion:9});
  const requested: string[]=[];
  await page.route('https://www.youtube-nocookie.com/**',route => {requested.push(route.request().url());return route.fulfill({body:'<title>Stub player</title>'});});
  await page.setContent(`<style>${assets.css}</style>${sanitizeBody(renderBlocks(blocks,{registry,renderVersion:9}))}<script>window.TyperollBlocks={register:function(type,fn){document.querySelectorAll('[data-block-type="'+type+'"]').forEach(fn)}};</script><script>${assets.js}</script>`);
  await expect(page.getByRole('button',{name:'Load video: Island film'})).toBeVisible();
  expect(requested).toHaveLength(0);
  await page.getByRole('button',{name:'Load video: Island film'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('iframe[title="Island film"]')).toHaveCount(1);
  await expect.poll(()=>requested.length).toBe(1);
  await expect(page.getByRole('button')).toHaveCount(0);
});
