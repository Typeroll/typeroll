import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, composePageWithTemplate, getPageTemplateStarter, getPartialCompositionStarter, getArchiveCompositionStarter, CONTENT_WELL_CSS, defaultSiteSettings, type Block, type PageTemplateStarterKind } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry=buildCoreBlockRegistry();
const reset=fs.readFileSync(new URL('../../../site-template/src/styles/reset.css',import.meta.url),'utf8');
const global=fs.readFileSync(new URL('../../../site-template/src/styles/global.css',import.meta.url),'utf8');
const photo='https://media.example.test/photo.svg';
const body:Block[]=[{id:'intro',type:'core/prose',data:{html:'<p>A short introduction with a clear purpose.</p>'}},
 {id:'video',type:'core/image',data:{src:photo,alt:'Complete subject'}},
 {id:'heading',type:'core/rich_heading',data:{html:'<a href="/detail/">A linked heading with a long and meaningful description</a>',level:'h2'}},
 {id:'copy',type:'core/prose',data:{html:'<p>Useful explanation after the heading. Content remains readable on small screens.</p>'}}];
const links=[{label:'About our work',href:'/about/'},{label:'Lång svensk navigeringsrubrik med flera ord',href:'/detail/'}];
const themes=[defaultSiteSettings.colors,{...defaultSiteSettings.colors,primary:'#8b2850',background:'#fffdf7',text:'#312724'}];
function documentHtml(content:Block[],theme=themes[0],extras={},items:Record<string, unknown>[] = []){
 const header=getPartialCompositionStarter('header',{links}),footer=getPartialCompositionStarter('footer',{links});
 const all=[...header,...content,...footer],assets=collectBlockAssets(all,registry);
 const context={site:{name:'Example publication'},page:{title:'A considered page title',path:'/detail/',content_mode:'blocks',blocks:body,breadcrumbs:[{title:'Home',url:'/'},{title:'Detail',url:'/detail/'}],...extras},item:{pdf:'/guide.pdf'},content_type:{fields:[{name:'role',label:'Role',type:'text'}]}};
 const render=(tree:Block[])=>sanitizeBody(renderBlocks(tree,{registry,context,pageSource:()=>items}));
 return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${reset}${global}${CONTENT_WELL_CSS}${assets.css}:root{${Object.entries(theme).map(([k,v])=>`--color-${k.replaceAll('_','-')}:${v};`).join('')}--font-body:Arial;--font-heading:Georgia}body{font-family:var(--font-body);color:var(--color-text);background:var(--color-background)}</style></head><body><header>${render(header)}</header><main class="page-content page-content--blocks">${render(content)}</main><footer>${render(footer)}</footer></body></html>`;
}
const menuScript=`window.TyperollBlocks={register(id,init){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(init)}};${registry.get('core/navigation_menu')!.script}`;
test.beforeEach(async({page})=>{await page.route(photo,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect x="2" y="2" width="596" height="396" fill="#cde6e2" stroke="#286858" stroke-width="4"/><circle cx="300" cy="200" r="140" fill="#286858"/></svg>'}));});
test('starter gallery stays readable without corrective CSS in two themes',async({page},info)=>{
 for(const kind of ['custom','article','blog','profile','landing','team','events','products','checklist'] as PageTemplateStarterKind[]) {
  const content=composePageWithTemplate(getPageTemplateStarter(kind)!,body);
  for(const width of [320,375,768,1024,1440]) {
   await page.setViewportSize({width,height:900});await page.setContent(documentHtml(content));await page.addScriptTag({content:menuScript});
   await expect(page.locator('main h1')).toHaveCount(1);
   await expect(page.locator('main img[src=""]')).toHaveCount(0);
   await expect(page.locator('main [data-block="page-date"]')).toHaveCount(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
   const paragraph=page.locator('main [data-block="prose"] p').first();const rect=(await paragraph.boundingBox())!;
   expect(rect.x).toBeGreaterThanOrEqual(width>=768?28:20);
   if(['article','profile','landing'].includes(kind)&&[375,1440].includes(width))await page.screenshot({path:info.outputPath(`${kind}-${width}.png`),fullPage:true});
  }
 }
 await page.setViewportSize({width:375,height:900});await page.setContent(documentHtml(composePageWithTemplate(getPageTemplateStarter('article')!,body),themes[1]));await page.addScriptTag({content:menuScript});
 await page.screenshot({path:info.outputPath('article-second-theme.png'),fullPage:true});
 // Browser-equivalent reflow at 200%: half the available CSS viewport, doubled root text.
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
test('default PDF links and mobile navigation are recognizable, inset and keyboard usable',async({page},info)=>{
 const cards:Block[]=[{id:'section',type:'core/section',data:{},children:[{id:'card',type:'core/post_card',data:{title:'A guide',href:'/detail/',action_label:'Read',download_url_field:'pdf'}}]}];
 for(const [index,theme] of themes.entries()) for(const width of [320,390,1280]) {
  await page.setViewportSize({width,height:900});
  await page.setContent(documentHtml(cards,theme));
  const pdf=page.getByRole('link',{name:'Download PDF'});
  await expect(pdf).toHaveCSS('text-decoration-line','underline');
  expect(await pdf.evaluate(e=>getComputedStyle(e).color)).toBe(await page.getByRole('link',{name:'Read',exact:true}).evaluate(e=>getComputedStyle(e).color));
  await page.addScriptTag({content:menuScript});
  if(width<1024){await page.getByRole('button',{name:'Open menu'}).click();const dialog=page.getByRole('dialog');
   const link=dialog.getByRole('link').first();expect((await link.boundingBox())!.x).toBeGreaterThanOrEqual(20);
   await link.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(link).toHaveCSS('outline-style','solid');
   if(width===390)await page.screenshot({path:info.outputPath(`menu-theme-${index}.png`)});
   await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
  }
 }
});
test('nested containers have no compounded padding; rich headings own no external margins; clipping is opt-in',async({page})=>{
 const tree:Block[]=[{id:'outer',type:'core/section',data:{},children:[{id:'group',type:'core/container',data:{radius_px:12,overflow:'clip'},children:[{id:'inner',type:'core/container',data:{background:'#ccffee'},children:[{id:'h',type:'core/rich_heading',data:{html:'<a href="/">Linked title</a>',font_size_px:20,align:{mobile:'left',tablet:'center'}}}]}]}]}];
 for(const width of [390,768]){
  await page.setViewportSize({width,height:900});await page.setContent(documentHtml(tree));
  const containers=page.locator('main [data-block="container"]');
  for(const node of await containers.all())await expect(node).toHaveCSS('padding','0px');
  await expect(containers.first()).toHaveCSS('overflow','clip');await expect(containers.nth(1)).toHaveCSS('overflow','visible');
  const heading=page.locator('main [data-block="rich_heading"]');
  await expect(heading).toHaveCSS('font-size','20px');await expect(heading).toHaveCSS('margin-top','0px');
  await expect(heading).toHaveCSS('text-align',width<640?'left':'center');
 }
});

test('archive cards handle zero, one and many items with complete portrait media and full-width backgrounds', async ({page}, info) => {
 const portrait = 'https://media.example.test/portrait.svg';
 await page.route(portrait, route => route.fulfill({ contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="#ccffee"/><path d="M0 0L200 400M200 0L0 400" stroke="black"/></svg>' }));
 const tree=getArchiveCompositionStarter({content_type:'articles',title:'Guides'});
 tree[0].data.background='#e7f5f3';
 for (const count of [0,1,7]) for (const width of [320,375,768,1024,1440]) {
  const items=Array.from({length:count},(_,i)=>({title:i===1?'A very long guide title that needs several readable lines without cropping or truncation':'Guide '+i,url:'/guide-'+i+'/',image:i%3===0?portrait:i%3===1?photo:'',excerpt:i%2===0?'A concise introduction.':'',image_alt:'Complete subject'}));
  await page.setViewportSize({width,height:900});await page.setContent(documentHtml(tree,themes[0],{},items));await page.addScriptTag({content:menuScript});
  const cards=page.locator('main [data-block="post_card"]');await expect(cards).toHaveCount(count);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const section=(await page.locator('main [data-block="section"]').boundingBox())!;expect(section.x).toBe(0);expect(section.width).toBe(width);
  if(count>1&&width<768){const first=(await cards.nth(0).boundingBox())!,second=(await cards.nth(1).boundingBox())!;expect(second.y).toBeGreaterThan(first.y+first.height);}
  for(const frame of await page.locator('main .block-postcard-image').all())expect((await frame.boundingBox())!.height).toBe(240);
  for(const img of await page.locator('main img').all()){await expect(img).toHaveCSS('object-fit','contain');await expect(img).toHaveJSProperty('complete',true);expect(await img.evaluate((e:HTMLImageElement)=>e.naturalHeight)).toBeGreaterThan(0);}
  if(count===7&&[375,1440].includes(width))await page.screenshot({path:info.outputPath(`archive-${width}.png`),fullPage:true});
 }
});
