import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, composePageWithTemplate, CONTENT_WELL_CSS, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry = buildCoreBlockRegistry();
const reset = fs.readFileSync(new URL('../../../site-template/src/styles/reset.css', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../site-template/src/styles/global.css', import.meta.url), 'utf8');
const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#80bbd2"/></svg>').toString('base64');
const links = Array.from({ length: 7 }, (_, i) => ({ label: `Service ${i+1}`, href: `#service-${i+1}` }));
const menu = (collapse = '1024'): Block => ({ id:'menu',type:'core/navigation_menu',data:{collapse_below:collapse,toggle_size_px:28,close_size_px:40},children:[
  { id:'primary',type:'core/navigation_links',data:{links:links.slice(0,2),font_size_px:28,color:'#075696',padding_y_px:16} },
  { id:'services',type:'core/container',data:{width:'full',padding_x_px:24,padding_y_px:24,background:'#e6faf6'},children:[
    { id:'service-heading',type:'core/heading',data:{text:'Services',level:'h2',font_size_px:24} },
    { id:'secondary',type:'core/navigation_links',data:{links:links.slice(2),color:'#008c86',font_size_px:24,padding_y_px:14} },
  ] },
] });
function html(tree: Block[], chrome = false) {
  const assets = collectBlockAssets(tree, registry);
  const rendered = sanitizeBody(renderBlocks(tree,{registry,context:{item:{pdf:'/guide.pdf'}}}));
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${reset}${css}${CONTENT_WELL_CSS}${assets.css}body{margin:0}header{display:flex;align-items:center;justify-content:space-between;padding:16px;height:80px;background:white;position:sticky;top:0}#content{height:1400px;padding:24px}</style></head><body>${chrome?`<header><a id="logo" href="#home">Example</a>${rendered}</header><main id="content"><h1>Page content</h1><button id="outside">Outside</button></main>`:`<main class="page-content page-content--blocks">${rendered}</main>`}</body></html>`;
}
const script = `window.TyperollBlocks={register(id,init){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(init)}};${registry.get('core/navigation_menu')!.script}`;
test('one block menu preserves header geometry, links and modal behavior at exact thresholds', async ({page},info) => {
  for (const threshold of [576,768,769,1024]) for (const width of [320,390,threshold-1,threshold]) {
    await page.setViewportSize({width,height:844});
    await page.setContent(html([menu(String(threshold))],true));
    await page.addScriptTag({content:script});
    const toggle = page.getByRole('button',{name:'Open menu'});
    if (width >= threshold) { await expect(toggle).toBeHidden(); await expect(page.locator('nav a')).toHaveCount(7); continue; }
    const before = await page.locator('#logo').boundingBox();
    const contentBefore = await page.locator('#content').boundingBox();
    await toggle.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(toggle.locator('svg')).toHaveCSS('width','28px');
    await expect(dialog.getByRole('button',{name:'Close menu'}).locator('svg')).toHaveCSS('width','40px');
    expect(await page.locator('#logo').boundingBox()).toEqual(before);
    expect(await page.locator('#content').boundingBox()).toEqual(contentBefore);
    expect(await dialog.locator('a').evaluateAll(nodes=>nodes.map(a=>a.getAttribute('href')))).toEqual(links.map(x=>x.href));
    await page.locator('#outside').evaluate((el:HTMLButtonElement)=>el.focus());
    expect(await page.evaluate(()=>!!document.activeElement?.closest('dialog'))).toBe(true);
    for(let i=0;i<10;i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(()=>!!document.activeElement?.closest('dialog'))).toBe(true); }
    if(threshold===1024 && width===390) await page.screenshot({path:info.outputPath('menu-open-390.png')});
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(toggle).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.style.overflow)).toBe('');
    await toggle.click(); await page.setViewportSize({width:threshold,height:844});
    await expect(dialog).toBeHidden(); await expect(toggle).toBeHidden();
    expect(await page.locator('nav > .block-menu-content a').count()).toBe(7);
    expect(await page.evaluate(()=>document.documentElement.style.overflow)).toBe('');
  }
});
test('menu content scrolls in landscape, closes on activation and remains usable without JavaScript', async ({page})=>{
  await page.setViewportSize({width:570,height:320}); await page.setContent(html([menu()],true));
  await expect(page.getByRole('button',{name:'Open menu'})).toBeHidden();
  await expect(page.locator('nav a')).toHaveCount(7); await expect(page.locator('nav a').last()).toBeVisible();
  await page.addScriptTag({content:script}); await page.getByRole('button',{name:'Open menu'}).click();
  const scroll=page.locator('.block-menu-scroll');
  expect(await scroll.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await page.getByRole('link',{name:'Service 7',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.style.overflow)).toBe('');
});
test('full-width template typography does not shrink nested page layouts',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  const body:Block[]=[{id:'outer',type:'core/container',data:{width:'full',padding_x_px:40,padding_y_px:0},children:[{id:'inner',type:'core/container',data:{width:'full',max_width_px:1120,padding_x_px:0,padding_y_px:0,inline_style:'width:100%;margin-inline:auto'},children:[{id:'h1',type:'core/heading',data:{text:'Contact',level:'h1'}}]}]}];
  for(const max_width of ['full','narrow','normal','wide'])for(const typography of [{},{font_size:16,line_height:1.6}]){
    const tree=composePageWithTemplate([{id:'body',type:'template_content_slot',data:{max_width,...typography}}],body);
    await page.setContent(html(tree));
    const rect=await page.locator('h1').boundingBox();
    const width=({full:1120,narrow:480,normal:640,wide:1040} as Record<string,number>)[max_width];
    expect(rect!.width).toBe(width);expect(rect!.x).toBe((1280-width)/2);
  }
});
test('responsive card presentation preserves one link or separate PDF actions without nested anchors',async({page},info)=>{
  const common={title:'Packing electronics',image,href:'/packing/',appearance:'card',show_date:false,show_author:false,image_fit:'cover',whole_card_link:true,image_height_px:{mobile:160,laptop:200},title_size_px:{mobile:17.6,laptop:20},title_line_height:1.3,title_weight:'500',body_padding_px:{mobile:12,laptop:15},radius_px:8};
  const tree:Block[]=[{id:'grid',type:'core/grid',data:{cols:{mobile:1,tablet:2},gap_px:20},children:[{id:'single',type:'core/post_card',data:common},{id:'pdf',type:'core/post_card',data:{...common,download_url_field:'pdf',download_style:'outline',action_label:'View',layout:'row',image_width_percent:40}}]}];
  for(const width of [375,768,1280]){
    await page.setViewportSize({width,height:900});await page.setContent(html(tree));
    const card=page.locator('[data-bid="single"]');
    await expect(card.locator('a')).toHaveCount(1);await expect(card).toHaveAttribute('data-whole','true');
    expect((await card.locator('img').boundingBox())!.height).toBe(width>=1024?200:160);
    expect(await card.locator('h3').evaluate(el=>getComputedStyle(el).fontWeight)).toBe('500');
    expect(parseFloat(await card.locator('h3').evaluate(el=>getComputedStyle(el).fontSize))).toBe(width>=1024?20:17.6);
    const pdf=page.locator('[data-bid="pdf"]'); await expect(pdf).toHaveAttribute('data-whole','false');
    expect(await pdf.locator('a a').count()).toBe(0);await expect(pdf.getByRole('link',{name:'Download PDF'})).toHaveAttribute('href','/guide.pdf');
    expect(await pdf.getByRole('link',{name:'Download PDF'}).evaluate(el=>getComputedStyle(el).borderTopStyle)).toBe('solid');
    await page.screenshot({path:info.outputPath(`cards-${width}.png`),fullPage:true});
  }
});

test('optional mobile blocks can differ completely from desktop without hidden tab stops',async({page})=>{
  const tree:Block={id:'different',type:'core/navigation_menu',data:{collapse_below:'768'},slots:[
    [{id:'desktop-links',type:'core/navigation_links',data:{links:[{label:'Desktop overview',href:'#desktop'}],direction:'row'}}],
    [{id:'mobile-heading',type:'core/heading',data:{text:'Explore services',level:'h2'}},{id:'mobile-links',type:'core/navigation_links',data:{links:[{label:'Mobile service',href:'#mobile'}],font_size_px:28}}]
  ]};
  await page.setViewportSize({width:390,height:844});await page.setContent(html([tree],true));
  await expect(page.getByRole('link',{name:'Mobile service'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Desktop overview'})).toBeHidden();
  await page.addScriptTag({content:script});await page.getByRole('button',{name:'Open menu'}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Explore services'})).toBeVisible();
  await expect(page.getByRole('dialog').locator('a')).toHaveCount(1);
  await page.setViewportSize({width:768,height:844});
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('link',{name:'Mobile service'})).toBeHidden();
  await expect(page.getByRole('link',{name:'Desktop overview'})).toBeVisible();
});

test('menu typography and both SVG and emoji icons follow numeric presentation',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  const tree:Block[]=[{id:'emoji',type:'core/icon',data:{icon:'🚚',size_px:{mobile:48,laptop:64}}},{id:'svg',type:'core/icon',data:{icon:'truck',size_px:{mobile:48,laptop:64}}},
    {id:'links',type:'core/navigation_links',data:{font:'heading',icon_size_px:24,icon_gap_px:12,links:[{icon:'truck',label:'Moving service',href:'/moving/'}]}}];
  await page.setContent(html(tree));
  await page.addStyleTag({content:':root{--font-heading:Arial;--font-body:Georgia}'});
  expect(await page.locator('[data-bid="emoji"]').evaluate(el=>getComputedStyle(el).fontSize)).toBe('64px');
  expect((await page.locator('[data-bid="emoji"]').boundingBox())!.height).toBe(64);
  expect((await page.locator('[data-bid="svg"] svg').boundingBox())!.width).toBe(64);
  const link=page.getByRole('link',{name:'Moving service'});
  expect(await link.evaluate(el=>getComputedStyle(el).fontFamily)).toBe('Arial');
  expect(await link.evaluate(el=>getComputedStyle(el).gap)).toBe('12px');
  expect((await link.locator('svg').boundingBox())!.width).toBe(24);
});

test('removing an open menu releases its document scroll lock',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.setContent(html([menu()],true));
  await page.addScriptTag({content:script});await page.getByRole('button',{name:'Open menu'}).click();
  await page.locator('nav').evaluate(el=>el.remove());
  await expect.poll(()=>page.evaluate(()=>document.documentElement.style.overflow)).toBe('');
});
