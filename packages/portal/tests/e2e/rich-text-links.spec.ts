import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry=buildCoreBlockRegistry();
const link=(label:string)=>`<a href="/guide/">${label}</a>`;
const blocks:Block[]=[
  {id:'list',type:'core/list',data:{items:[{html:link('Book a moving van')},{html:link('Book movers')}]}},
  {id:'table',type:'core/table',data:{caption:link('Table caption'),source:link('Table source'),rows:[{cells:[{html:link('Cell reference')}]}]}},
  {id:'image',type:'core/image',data:{src:'/drawing.svg',alt:'Drawing',link:'/image/',caption_html:link('Image credit')}},
  {id:'heading',type:'core/rich_heading',data:{html:link('Linked heading'),level:'h2'}},
  {id:'prose',type:'core/prose',data:{html:link('Prose link')}},
  {id:'icon',type:'core/icon_box',data:{heading:'Card heading',whole_card_link:true,link:'/card/',text:link('Card body reference')}},
  {id:'hero',type:'core/hero',data:{heading:'Hero',subheading:link('Hero text reference')}},
  {id:'cta',type:'core/cta',data:{heading:'Call to action',subheading:link('Callout reference')}},
  {id:'quote',type:'core/testimonial',data:{quote:link('Quote reference')}},
  {id:'person',type:'core/team_member',data:{name:'Person',photo:'/drawing.svg',bio:link('Bio reference')}},
  {id:'step',type:'core/step_card',data:{title:'Step',text:link('Step reference')}},
  {id:'media',type:'core/media_card',data:{title:'Media',text:link('Media body reference')}},
  {id:'feature',type:'core/feature_row',data:{heading:'Feature',text:link('Feature reference')}},
  {id:'help',type:'form/help',data:{summary:'Help',body:link('Help reference')}},
  {id:'consent',type:'form/consent',data:{text:link('Consent reference')}},
  {id:'button',type:'core/button',data:{label:'Continue',href:'/continue/'}},
  {id:'card',type:'core/post_card',data:{title:'Article card',href:'/card/',image:'/drawing.svg',image_alt:'Card illustration'}},
  {id:'nav',type:'core/navigation_links',data:{links:[{label:'Navigation',href:'/nav/'}]}},
];
test('all native rich-text link surfaces survive theme resets without changing interactive chrome',async({page},info)=>{
  await page.route('**/drawing.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#cef"/></svg>'}));
  const assets=collectBlockAssets(blocks,registry);
  await page.setContent(`<html><head><base href="https://fixture.invalid/"><style>body{font-family:Arial;margin:20px}a{text-decoration:none} ${assets.css}</style></head><body>${sanitizeBody(renderBlocks(blocks,{registry,annotate:true}))}</body></html>`);
  for(const width of [390,1280]){
    await page.setViewportSize({width,height:1000});
    for(const text of ['Book a moving van','Book movers','Table caption','Table source','Cell reference','Image credit','Linked heading','Prose link','Card body reference','Hero text reference','Callout reference','Quote reference','Bio reference','Step reference','Media body reference','Feature reference','Help reference','Consent reference']){
      const a=page.getByRole('link',{name:text,exact:true,includeHidden:true});
      await expect(a).toHaveCount(1);await expect(a).toHaveCSS('text-decoration-line','underline');
    }
    for(const selector of ['[data-block="image"] > .block-image-link','.block-postcard-title a','.block-postcard-media > a','[data-block="button"] a','[data-block="navigation_links"] a','.block-iconbox-heading a'])await expect(page.locator(selector)).toHaveCSS('text-decoration-line','none');
    await page.getByRole('link',{name:'Book a moving van',exact:true}).focus();
    await expect(page.getByRole('link',{name:'Book a moving van',exact:true})).toHaveCSS('outline-style','solid');
    await page.screenshot({path:info.outputPath(`rich-links-${width}.png`),fullPage:true});
  }
});
