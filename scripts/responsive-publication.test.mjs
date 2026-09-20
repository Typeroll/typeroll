import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicationBuildHarness } from './lib/publication-build-harness.mjs';

test('frozen publication renders site widths and shared breadcrumb labels and invalidates warm output', async t => {
  const page = (id, extra = {}) => ({ id, slug:id, title:`Full ${id} title`, status:'published', content_mode:'blocks',
    blocks:[{id:`${id}-body`,type:'core/prose',data:{html:`<p>${id} text</p>`,font_size_px:{mobile:14.4,laptop:18}}}], ...extra });
  const value = { format:'typeroll-static-publication',format_version:2,publication_id:'a'.repeat(64),core_commit:'a'.repeat(40),
    site_url:'https://example.invalid',version_id:'main',site:{name:'Example'},
    settings:{site_name:'Example',trailing_slash:'always',responsive_breakpoints:{tablet:576,laptop:769,desktop:1024,wide:1280}},
    pages:[page('home',{path:'/'}),page('tips',{breadcrumb_label:'Tips'}),page('article',{parent:'tips',path:'/tips/article',template:'article'})],
    pageTemplates:[{id:'article',status:'published',blocks:[{id:'trail',type:'template/page_breadcrumbs',data:{}},{id:'title',type:'template/page_title',data:{}},{id:'body',type:'template_content_slot',data:{}}]}],
    media:[],partials:[],contentTypes:[],blockTypes:[],forms:[] };
  const harness = await publicationBuildHarness(value);
  t.after(harness.cleanup);
  const html = () => fs.readFile(path.join(harness.destination,'dist/tips/article/index.html'),'utf8');
  await harness.run();
  const first = await html();
  assert.match(first, /min-width:\s*769px/);
  assert.match(first, /--font_size_px:\s*14\.4px/);
  assert.match(first, /href="\/tips\/"[^>]*>Tips<\/a>/);
  assert.match(first, /Full article title/);
  assert.equal((await harness.run()).report.reused,3);
  value.pages[1].breadcrumb_label = 'Moving tips';
  assert.equal((await harness.run()).report.rendered,2);
  assert.match(await html(), /href="\/tips\/"[^>]*>Moving tips<\/a>/);
  value.settings.responsive_breakpoints.laptop = 800;
  assert.equal((await harness.run()).report.rendered,3);
  assert.match(await html(), /min-width:\s*800px/);
  assert.doesNotMatch(await html(), /min-width:\s*769px/);
});

test('frozen component controls survive export and invalidate only affected content until renderer changes', async t => {
  const card = {id:'card',type:'core/post_card',data:{title:'Guide',href:'/',image:'https://media.example.invalid/photo.png',image_alt:'Packing',show_date:false,
    responsive_breakpoints:{tablet:577,laptop:769,desktop:1041,wide:1440},
    layout:{mobile:'column',desktop:'row'},image_sizing:{mobile:'fixed',desktop:'stretch'},image_height_px:200,
    appearance:'card',border_width_px:3,border_color:'#dddddd',action_label:'Read',title_font:'body'}};
  const value={format:'typeroll-static-publication',format_version:2,publication_id:'b'.repeat(64),core_commit:'b'.repeat(40),site_url:'https://example.invalid',version_id:'main',
    site:{name:'Example'},settings:{site_name:'Example',trailing_slash:'always'},
    pages:[{id:'home',path:'/',slug:'home',title:'Home',status:'published',content_mode:'blocks',blocks:[card]},
      {id:'other',slug:'other',title:'Other',status:'published',content_mode:'blocks',blocks:[]}],
    media:[],partials:[],pageTemplates:[],contentTypes:[],blockTypes:[],forms:[]};
  const harness=await publicationBuildHarness(value);t.after(harness.cleanup);
  const html=()=>fs.readFile(path.join(harness.destination,'dist/index.html'),'utf8');
  await harness.run();
  assert.match(await html(), /min-width:\s*1041px/);
  assert.match(await html(), /--card-image-position:\s*absolute\s*!important/);
  assert.match(await html(), /--border_width_px:\s*3px/);
  assert.match(await html(), /class="block-postcard-link"><span>Guide<\/span><\/a>/);
  assert.equal((await harness.run()).report.reused,2);
  card.data.responsive_breakpoints.desktop=1100;
  assert.equal((await harness.run()).report.rendered,1);
  assert.match(await html(), /min-width:\s*1100px/);
  const source=path.join(harness.destination,'packages/shared/src/tier1-blocks.ts');
  await fs.appendFile(source,'\n// Renderer dependency change for cache qualification.\n');
  assert.equal((await harness.run()).report.rendered,2);
});

test('qualified composition defaults reach the real frozen Astro build and invalidate warm HTML', async t => {
  const { build } = await import('esbuild');
  const compiled = await build({ stdin: { contents: "export * from './packages/shared/src/page-template-starters.ts'; export * from './packages/shared/src/site-compositions.ts';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false });
  const { getPageTemplateStarter, getPartialCompositionStarter } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const value = { format: 'typeroll-static-publication', format_version: 2, publication_id: 'c'.repeat(64), core_commit: 'c'.repeat(40),
    site_url: 'https://example.invalid', version_id: 'main', site: { name: 'Example' }, settings: { site_name: 'Example', trailing_slash: 'always' },
    pages: [{ id: 'home', path: '/', slug: 'home', title: 'Home', status: 'published', template: 'profile', content_mode: 'blocks', blocks: [
      { id: 'group', type: 'core/container', data: { radius_px: 12, overflow: 'clip', background_gradient: { from: '#f8fbff', to: '#e8f4fc', angle: 135 } }, children: [
        { id: 'heading', type: 'core/rich_heading', data: { html: '<a href="/">A linked heading</a>', level: 'h2', font_size_px: 20, align: { mobile: 'left', tablet: 'center' } } },
        { id: 'card', type: 'core/post_card', data: { title: 'Guide', href: '/', whole_card_link: true, hover_background: '#e8f4fc', hover_border_color: '#186ec0' } },
      ] },
    ] }],
    partials: ['header', 'footer'].map(kind => ({ id: kind, name: kind, kind, status: 'published', content_mode: 'blocks', blocks: getPartialCompositionStarter(kind, { links: [{ label: 'Home', href: '/' }] }) })),
    pageTemplates: [{ id: 'profile', status: 'published', blocks: getPageTemplateStarter('profile') }],
    media: [], contentTypes: [], blockTypes: [], forms: [] };
  const harness = await publicationBuildHarness(value); t.after(harness.cleanup);
  await harness.run();
  const html = await fs.readFile(path.join(harness.destination, 'dist/index.html'), 'utf8');
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /data-block="navigation_menu"/);
  assert.match(html, /data-overflow="clip"/);
  assert.match(html, /linear-gradient\(135deg,#f8fbff 0%,#e8f4fc 100%\)/);
  assert.match(html, /data-density="compact-desktop"/);
  assert.match(html, /--card-hover-bg:\s*#e8f4fc/);
  assert.match(html, /--padding_x:\s*none/);
  assert.match(html, /--font_size_px:\s*20px/);
  assert.match(html, /data-block="rich_heading"/);
  assert.doesNotMatch(html, /<img[^>]*src=""/);
  assert.doesNotMatch(html, /<[^>]+data-block="page-excerpt"/);
  assert.equal((await harness.run()).report.reused, 1);
  await fs.appendFile(path.join(harness.destination, 'packages/shared/src/surface-presentation.ts'), '\n// Presentation dependency qualification.\n');
  assert.equal((await harness.run()).report.rendered, 1);
});
