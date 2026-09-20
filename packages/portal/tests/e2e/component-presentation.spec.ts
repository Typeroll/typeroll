import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry = buildCoreBlockRegistry();
const widths = { tablet: 577, laptop: 769, desktop: 1024, wide: 1280 };
const cardWidths = { tablet: 577, laptop: 769, desktop: 1041, wide: 1440 };
const image = 'https://media.example.test/packing.svg';
test.beforeEach(async ({page}) => {
  await page.route(image, route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#a2e1da"/><circle cx="300" cy="150" r="90" fill="#168c83"/></svg>'}));
});
const checklist = (id: string, media = true): Block => ({ id, type: 'core/post_card', data: {
  responsive_breakpoints: cardWidths, title: 'Checklist with a long descriptive heading', href: '/guide/',
  excerpt: 'Moving takes planning. '.repeat(24), image: media ? image : '', show_date: false, show_author: false,
  appearance: 'card', border_width_px: 3, border_color: '#dddddd', shadow: 'none', radius_px: 6,
  layout: { mobile: 'column', desktop: 'row' }, image_width_percent: 40, image_fit: 'cover',
  image_sizing: { mobile: 'fixed', desktop: 'stretch' }, image_height_px: 200,
  body_padding_x_px: 16, body_padding_y_px: 12, body_gap_px: 20, title_size_px: 20,
  action_label: 'Read', action_size_px: 14, action_weight: '600', actions_align: 'center',
  actions_direction: { mobile: 'column', desktop: 'row' }, actions_gap_px: 20,
  download_url_field: 'pdf', download_behavior: 'download', download_style: 'outline', download_color: '#009d9d',
  download_border_width_px: 3, download_radius_px: 6, download_padding_x_px: 20, download_padding_y_px: 12,
  download_width: { mobile: 'full', desktop: 'fill' }, download_size_px: 13, download_weight: '700',
} });
function html(tree: Block[]) {
  const assets = collectBlockAssets(tree, registry);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:Arial;--font-body:Arial;--font-heading:Georgia}h3{font-family:var(--font-heading)}${assets.css}</style></head><body>${sanitizeBody(renderBlocks(tree,{registry,context:{site:{responsive_breakpoints:widths},item:{pdf:'/guide.pdf'}}}))}</body></html>`;
}
test('independent checklist thresholds, stretched media and styled accessible actions survive sanitization', async ({page}, info) => {
  await page.setContent(html([checklist('photo'), checklist('no-photo', false)]));
  const card = page.locator('[data-block="post_card"]').first();
  const body = card.locator('.block-postcard-body');
  const media = card.locator('.block-postcard-image');
  const pdf = card.getByRole('link', {name:'Download PDF'});
  for(const width of [320,390,480,481,576,577,768,769,991,992,1040,1041,1280]) {
    await page.setViewportSize({width,height:1000});
    await expect(card).toHaveCSS('flex-direction',width<1041?'column':'row');
    await expect(card).toHaveCSS('border-top-width','3px');
    await expect(pdf).toHaveCSS('font-size','13px'); await expect(pdf).toHaveCSS('font-weight','700');
    await expect(pdf).toHaveCSS('border-top-width','3px'); await expect(pdf).toHaveCSS('padding-left','20px');
    await expect(pdf).toHaveCSS('border-radius','6px'); await expect(pdf).toHaveAttribute('download','');
    await expect(card.getByRole('heading').getByRole('link',{name:'Checklist with a long descriptive heading',exact:true})).toHaveAttribute('href','/guide/');
    await expect(card.getByRole('link',{name:'Read',exact:true})).toHaveAttribute('href','/guide/');
    await expect(card.locator('a a')).toHaveCount(0);
    const imageBox = (await media.boundingBox())!, bodyBox = (await body.boundingBox())!;
    if(width<1041) {
      expect(imageBox.height).toBe(200);
      expect((await pdf.boundingBox())!.width).toBeCloseTo(bodyBox.width-32,0);
    } else {
      expect(imageBox.height).toBeCloseTo(bodyBox.height,0);
      const read=(await card.getByRole('link',{name:'Read',exact:true}).boundingBox())!, download=(await pdf.boundingBox())!;
      expect(read.y+read.height/2).toBeCloseTo(download.y+download.height/2,0);
      expect(download.width).toBeCloseTo(bodyBox.width-32-read.width-20,0);
    }
    await expect(page.locator('[data-block="post_card"]').nth(1).locator('.block-postcard-media')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if([390,1040,1041,1280].includes(width))await page.screenshot({path:info.outputPath(`checklist-${width}.png`),fullPage:true});
  }
});
test('category headers have fixed left tracks and independent stack thresholds; link cards use body font', async ({page},info) => {
  const tree:Block[]=[{id:'header',type:'core/container',data:{width:'full',padding_x_px:0,padding_y_px:0,shadow:'subtle',radius_px:6},children:[
    {id:'columns',type:'core/columns',data:{responsive_breakpoints:{tablet:481,laptop:992,desktop:1041,wide:1440},left_width_px:150,stack_below_px:481,gap_px:0,align:'center'},slots:[
      [{id:'icon-panel',type:'core/container',data:{width:'full',padding_x_px:0,padding_y_px:0,min_height_px:{mobile:120,tablet:150},responsive_breakpoints:{tablet:481,laptop:992,desktop:1041,wide:1440}},children:[{id:'image',type:'core/image',data:{src:image,alt:'Packing',link:'/packing/'}}]}],
      [{id:'title',type:'core/heading',data:{text:'Packing advice',level:'h2'}}],
    ]},
    {id:'link',type:'core/post_card',data:{title:'More packing advice',href:'/packing/',show_image:false,show_date:false,show_excerpt:false,whole_card_link:true,title_icon:'arrow-right',appearance:'card',background:'#f8f9fa',body_padding_x_px:16,body_padding_y_px:12,title_font:'body'}},
  ]}];
  await page.setContent(html(tree));
  for(const width of [320,390,480,481,576,577,768,769,991,992,1040,1041,1280]){
    await page.setViewportSize({width,height:900});
    const columns=page.locator('[data-block="columns"]');
    expect(await columns.evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length)).toBe(width<481?1:2);
    if(width>=481)expect((await columns.locator(':scope > div').first().boundingBox())!.width).toBe(150);
    await expect(page.locator('.block-postcard-body')).toHaveCSS('padding','12px 16px');
    await expect(page.locator('[data-block="post_card"]')).toHaveCSS('background-color','rgb(248, 249, 250)');
    await expect(page.locator('.block-postcard-title')).toHaveCSS('font-family','Arial');
    await expect(page.locator('[data-block="post_card"] a')).toHaveCount(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.screenshot({path:info.outputPath('category-1280.png'),fullPage:true});
});
