import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, renderBlocks, collectBlockAssets, composePageWithTemplate, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry=buildCoreBlockRegistry();
const widths={tablet:577,laptop:769,desktop:1024,wide:1280};
const url='https://media.example.test/framing.svg';
const body:Block[]=[{id:'nested',type:'core/container',data:{padding_x_px:0,padding_y_px:0},children:[2,3,4].map(level=>({id:`h${level}`,type:level===3?'core/rich_heading':'core/heading',data:{text:`Heading ${level}`,html:`Heading ${level}`,level:`h${level}`,size:'article'}}))},{id:'explicit',type:'core/heading',data:{text:'Own size',level:'h2',font_size_px:42,align:{mobile:'center',laptop:'left'},responsive_breakpoints:widths}}];
const blocks:Block[]=[{id:'prose-link',type:'core/prose',data:{html:'<p>Read <a href="/guide/">the guide</a>.</p>'}}, {id:'button-link',type:'core/button',data:{label:'Start',href:'/start/'}},{id:'trail',type:'template/page_breadcrumbs',data:{}},
  {id:'framed',type:'core/image',data:{src:url,alt:'Wide illustration',link:'/',original_width:600,original_height:150,width:'full',responsive_breakpoints:widths,scale_percent:{mobile:120,tablet:100},focal_x:50}},
  {id:'default',type:'core/image',data:{src:url,alt:'Uncropped illustration',original_width:600,original_height:150,width:'full'}},
  {id:'card',type:'core/post_card',data:{title:'Positioned image',image:url,href:'/',responsive_breakpoints:widths,image_fit:{mobile:'cover',tablet:'contain'},image_aspect:{mobile:'square',tablet:'auto'},focal_x:{mobile:25,tablet:50},focal_y:75}},
  ...composePageWithTemplate([{id:'body',type:'template_content_slot',data:{responsive_breakpoints:{tablet:481,laptop:769,desktop:1024,wide:1280},h2_size_px:{mobile:24,tablet:28,laptop:32},h3_size_px:{mobile:20,tablet:24,laptop:28},h4_size_px:{mobile:18,tablet:20,laptop:24}}}],body),
];
test('continuous breadcrumb lines, intentional framing and inherited article scale at exact boundaries',async({page},info)=>{
  await page.route(url,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="150"><rect width="600" height="150" fill="#dfefea"/><rect x="0" width="50" height="150" fill="#d96f52"/><rect x="550" width="50" height="150" fill="#4f75a0"/><circle cx="300" cy="75" r="50" fill="#428575"/></svg>'}));
  const assets=collectBlockAssets(blocks,registry);
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:Arial} a{text-decoration:none} ${assets.css}</style></head><body>${sanitizeBody(renderBlocks(blocks,{registry,annotate:true,context:{page:{breadcrumbs:[{label:'Tips om flytt',href:'/tips/'},{label:'En lång svensk artikelrubrik som ska fortsätta på samma rad innan den bryts',current:true}]}}}))}</body></html>`);
  await page.locator('[data-block-id="framed"] img').evaluate((img:HTMLImageElement)=>img.decode());
  for(const width of [320,390,480,481,576,577,768,769,1280]){
    await page.setViewportSize({width,height:1000});
    const framed=page.locator('[data-block-id="framed"]'),img=framed.locator('img'),frame=framed.locator('.block-image-frame');
    const f=(await frame.boundingBox())!, i=(await img.boundingBox())!;
    expect(i.width).toBeCloseTo(f.width*(width<=576?1.2:1),0);
    expect(i.height).toBeCloseTo(i.width/4,0); expect(f.height).toBeCloseTo(i.height,0);
    expect(i.x+i.width/2).toBeCloseTo(f.x+f.width/2,0);
    const normal=page.locator('[data-block-id="default"] img');
    expect((await normal.boundingBox())!.width).toBeCloseTo(width-32,0);
    await expect(normal).toHaveCSS('object-fit','contain');
    const card=page.locator('[data-block-id="card"] img');
    await expect(card).toHaveCSS('object-fit',width<577?'cover':'contain');
    await expect(card).toHaveCSS('aspect-ratio',width<577?'1 / 1':'auto');
    await expect(card).toHaveCSS('object-position',width<577?'25% 75%':'50% 75%');
    for(const level of [2,3,4]){
      const size=({2:[24,28,32],3:[20,24,28],4:[18,20,24]} as Record<number,number[]>)[level][width<=480?0:width<=768?1:2];
      await expect(page.locator(`[data-block-id="h${level}"]${level===3?'':' .block-heading-text'}`)).toHaveCSS('font-size',`${size}px`);
    }
    await expect(page.locator('[data-block-id="explicit"] .block-heading-text')).toHaveCSS('font-size','42px');
    await expect(page.locator('[data-block-id="explicit"]')).toHaveCSS('text-align',width<769?'center':'left');
    await expect(page.locator('[data-block="prose"] a')).toHaveCSS('text-decoration-line','underline');
    await expect(page.locator('[data-block="button"] a')).toHaveCSS('text-decoration-line','none');
    await expect(page.locator('.block-postcard-title a')).toHaveCSS('text-decoration-line','none');
    const trail=page.locator('[data-block="breadcrumbs"]');
    await expect(trail.getByRole('list')).toHaveCount(1); await expect(trail.getByRole('listitem')).toHaveCount(3);
    const positions=await trail.evaluate(nav=>{const first=nav.querySelector('a')!.getBoundingClientRect();const range=document.createRange();const text=nav.querySelector('[aria-current="page"]')!.firstChild!;range.setStart(text,0);range.setEnd(text,2);return{first:first.y,current:range.getBoundingClientRect().y}});
    expect(Math.abs(positions.current-positions.first)).toBeLessThan(2);
    await framed.getByRole('link').focus(); await expect(framed.getByRole('link')).toHaveCSS('outline-style','solid');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if([390,577,1280].includes(width))await page.screenshot({path:info.outputPath(`framing-${width}.png`),fullPage:true});
  }
});
