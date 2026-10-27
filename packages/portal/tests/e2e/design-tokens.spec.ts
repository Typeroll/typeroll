import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady } from './helpers/ready';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, siteThemeCss, siteStylesCss, defaultSiteSettings, resolveBreakpointWidths, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry = buildCoreBlockRegistry();
const blocks: Block[] = [
  { id:'header',type:'core/section',data:{background:'primary',text_color:'on_primary',padding_y:'compact'},children:[{id:'nav',type:'core/navigation_links',data:{color:'on_primary',links:[{label:'Home',href:'#home'},{label:'About',href:'#about'}]}}]},
  { id:'card',type:'core/post_card',data:{title:'A reusable card',excerpt:'The site palette controls this card.',background:'surface',hover_background:'surface_hover',href:'#about',appearance:'card',whole_card_link:true,body_padding_x_px:'lg',body_padding_y_px:'lg'}},
  { id:'button',type:'core/button',data:{label:'Continue',href:'#about'}},
  { id:'text',type:'core/prose',data:{html:'<p>One scale, everywhere.</p>',font_size_px:{mobile:'md',desktop:'xl'},line_height:'relaxed'}},
  { id:'footer',type:'core/section',data:{background:'primary',text_color:'on_primary',padding_y:'compact'},children:[{id:'footer-text',type:'core/prose',data:{html:'<p>Footer</p>'}}]},
];
for (const width of [375,768,1280]) test(`palette changes propagate without block edits at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width,height:900});
  const before = JSON.stringify(blocks);
  const assets = collectBlockAssets(blocks,registry,{renderVersion:9});
  const markup = sanitizeBody(renderBlocks(blocks,{registry,renderVersion:9,annotate:true}));
  const settings = {...structuredClone(defaultSiteSettings),render_version:9};
  const theme = () => siteThemeCss(settings) + siteStylesCss(settings.styles,{colors:settings.colors,breakpoints:resolveBreakpointWidths(),renderVersion:9});
  await page.setContent(`<style>body{margin:0}#home{padding:1rem}${assets.css}</style><style id="theme">${theme()}</style><main id="home">${markup}</main>`);
  await expect(page.locator('[data-block="post_card"]')).toHaveCSS('background-color', settings.colors.surface === '#f3f4f6' ? 'rgb(243, 244, 246)' : 'rgb(248, 250, 252)');
  settings.colors.primary = '#be185d'; settings.colors.surface = '#fce7f3';
  await page.locator('#theme').evaluate((el,css)=>el.textContent=css,theme());
  for (const id of ['header','footer']) await expect(page.locator(`[data-block-id="${id}"]`)).toHaveCSS('background-color','rgb(190, 24, 93)');
  await expect(page.locator('[data-block="post_card"]')).toHaveCSS('background-color','rgb(252, 231, 243)');
  await expect(page.locator('[data-block-id="text"]')).toHaveCSS('font-size',width >= 1280 ? '24px' : '16px');
  await expect(page.locator('[data-block="navigation_links"] a').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('.block-button-link')).toHaveCSS('background-color', 'rgb(190, 24, 93)');
  expect(JSON.stringify(blocks)).toBe(before);
  await page.screenshot({path:info.outputPath(`tokens-${width}.png`),fullPage:true});
});

test('editor stores palette and scale names and labels fixed values as exceptions', async ({page}, info) => {
  const file = path.join(os.tmpdir(),'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/pages/token-editor.json');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file, JSON.stringify({id:'token-editor',title:'Token editor',slug:'token-editor',status:'draft',content_mode:'blocks',blocks:[{id:'heading',type:'core/heading',data:{text:'Palette preview',level:'h2'}}]}));
  try {
    await page.setViewportSize({width:1280,height:1000});
    await gotoReady(page,'/app/sites/default/pages/token-editor');
    await page.getByRole('button',{name:'Structure',exact:true}).click();
    await page.getByRole('button',{name:'Edit Palette preview',exact:true}).click();
    await page.getByText('Advanced settings',{exact:true}).click();
    await page.getByText('Appearance',{exact:true}).click();
    const color = page.getByLabel('Text color',{exact:true});
    await color.selectOption('primary');
    const size = page.getByLabel('Text size (px)',{exact:true});
    await size.selectOption('xl');
    const heading = page.frameLocator('iframe[title="Preview"]').getByRole('heading',{name:'Palette preview'});
    await expect(heading).toHaveCSS('font-size','24px');
    await expect(color).toHaveValue('primary');
    await color.selectOption('__custom');
    await expect(page.getByText('Exception: a fixed colour does not follow palette changes. Record the reason in decisions.md.')).toBeVisible();
    await page.getByLabel('Text color custom colour').fill('surfase');
    await expect(page.getByRole('alert').filter({hasText:'Unknown colour'})).toBeVisible();
    await color.selectOption('primary');
    await page.screenshot({path:info.outputPath('token-editor.png')});
  } finally { rmSync(file,{force:true}); }
});
