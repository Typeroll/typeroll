import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, siteThemeCss, siteStylesCss, defaultSiteSettings, contentWellCss, newSiteStyles, resolveBreakpointWidths, type Block } from '@typeroll/shared';
import { gotoReady } from './helpers/ready';
const globalCss = readFileSync(new URL('../../../site-template/src/styles/global.css',import.meta.url),'utf8');
const registry = buildCoreBlockRegistry();
const blocks: Block[] = [
  {id:'intro',type:'core/prose',data:{html:'<p>A paragraph before the heading.</p>'}},
  {id:'flow',type:'core/heading',data:{level:'h2',size:'theme',text:'Editorial heading'}},
  {id:'card',type:'core/post_card',data:{title:'A card title',excerpt:'A short card description.',appearance:'card',title_tag:'h2'}},
  {id:'box',type:'core/container',data:{padding_x:'md',padding_y:'md',rhythm:'article'},children:[{id:'opening',type:'core/heading',data:{level:'h2',size:'theme',text:'Opening heading'}},{id:'body',type:'core/prose',data:{html:'<p>A readable paragraph.</p>'}}]},
  {id:'section',type:'core/section',data:{padding_y:'md'},children:[{id:'section-heading',type:'core/heading',data:{level:'h2',size:'theme',text:'Section heading'}}]},
];
for(const width of [375,768,1280]) test(`fluid role rhythm and component boundaries at ${width}px`, async({page},info)=>{
  await page.setViewportSize({width,height:1000});
  const settings = {...structuredClone(defaultSiteSettings),render_version:10,styles:newSiteStyles()};
  const theme = () => siteThemeCss(settings)+siteStylesCss(settings.styles,{colors:settings.colors,breakpoints:resolveBreakpointWidths(),renderVersion:10});
  const assets = collectBlockAssets(blocks,registry,{renderVersion:10});
  await page.setContent(`<style>${globalCss}html{font-size:16px}body{margin:0;padding:20px}${contentWellCss(10)}${assets.css}</style><style id="theme">${theme()}</style><main class="page-content">${renderBlocks(blocks,{registry,renderVersion:10,annotate:true})}</main>`);
  const heading=page.getByRole('heading',{name:'Editorial heading'});
  const metrics=await heading.evaluate(el=>({size:parseFloat(getComputedStyle(el).fontSize),before:parseFloat(getComputedStyle(el).marginBlockStart)}));
  expect(metrics.size).toBeGreaterThanOrEqual(27.6); expect(metrics.size).toBeLessThanOrEqual(31.3);
  expect(metrics.before).toBeCloseTo(metrics.size,1);
  for(const name of ['A card title','Opening heading','Section heading']) await expect(page.getByRole('heading',{name})).toHaveCSS('margin-top','0px');
  settings.typography={ratio_mobile:1.3,ratio_desktop:1.4,rhythm:1.2,line_length:55};
  await page.locator('#theme').evaluate((el,css)=>el.textContent=css,theme());
  const adjusted=await heading.evaluate(el=>({size:parseFloat(getComputedStyle(el).fontSize),before:parseFloat(getComputedStyle(el).marginBlockStart)}));
  expect(adjusted.size).toBeGreaterThan(metrics.size); expect(adjusted.before/adjusted.size).toBeCloseTo(1.2,1);
  await page.screenshot({path:info.outputPath(`fluid-${width}.png`),fullPage:true});
});
test('settings preview is isolated and updates before save at three real widths',async({page},info)=>{
  await gotoReady(page,'/app/sites/default/settings?section=design');
  const upgrade=await page.request.post('/api/sites/default/render-version',{data:{render_version:10},headers:{Origin:new URL(page.url()).origin}});
  expect(upgrade.ok(),await upgrade.text()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading',{name:'Typography at three widths'})).toBeVisible();
  const frames=page.locator('iframe[title^="Typography at"]');
  await expect(frames).toHaveCount(3);
  for(let i=0;i<3;i++) await expect(frames.nth(i)).toHaveAttribute('sandbox','');
  await page.getByLabel('Spacing rhythm',{exact:true}).fill('1.4');
  const frame=page.frameLocator('iframe[title="Typography at 375px"]');
  await expect.poll(()=>frame.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--type-rhythm').trim())).toBe('1.4');
  await page.getByRole('button',{name:'Save Design',exact:true}).click();
  await expect(page.locator('#settings-save-status')).toContainText('Saved.');
  await page.reload();
  await expect(page.getByLabel('Spacing rhythm',{exact:true})).toHaveValue('1.4');
  await page.screenshot({path:info.outputPath('settings-fluid-preview.png'),fullPage:true});
  await page.setViewportSize({width:375,height:812});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('heading',{name:'Typography at three widths'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('settings-fluid-mobile.png')});
});
