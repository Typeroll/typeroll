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
