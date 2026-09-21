import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { withMediaFixture } from '../../../../scripts/lib/test-media-storage.mjs';
import { publicationBuildHarness } from '../../../../scripts/lib/publication-build-harness.mjs';
import { prepareMedia } from '../../../../scripts/fixtures/static-publication/media.mjs';

test('frozen publication offers real full-resolution derivatives to the browser', async ({ page }, info) => {
  await withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
    await prepareMedia(publication, root);
    const media = { ...publication.media[0], cdn_url: entry.cdn_url, mime_type: entry.mime_type, alt: 'Moving illustration' };
    const value = { format:'typeroll-static-publication',format_version:2,publication_id:'a'.repeat(64),core_commit:'a'.repeat(40),site_url:'https://example.invalid',version_id:'main',site:{name:'Example'},
      settings:{site_name:'Example',trailing_slash:'always',image_sizes_default:'100vw'},
      pages:[{id:'home',path:'/',slug:'home',title:'Moving guide',status:'published',content_mode:'blocks',blocks:[
        {id:'image',type:'core/image',data:{src:entry.cdn_url,alt:'Moving illustration'}},
      ]}],media:[media],partials:[],pageTemplates:[],contentTypes:[],blockTypes:[],forms:[] };
    const harness=await publicationBuildHarness(value);
    try {
      await harness.run();
      const html=await fs.readFile(path.join(harness.destination,'dist/index.html'),'utf8');
      await page.route('https://images.example.com/**', async route => {
        const key=publication.media_manifest.site_prefix + new URL(route.request().url()).pathname;
        const bytes=stored.get(key);
        if (!bytes) return route.abort();
        const meta=await sharp(bytes).metadata();
        await route.fulfill({contentType:`image/${meta.format === 'heif' ? 'avif' : meta.format}`,body:bytes});
      });
      await page.setViewportSize({width:768,height:1000});
      await page.setContent(html);
      // Match the real site's rendered image width while retaining the exact
      // generated picture/srcset and encoded publication bytes.
      await page.addStyleTag({content:'[data-block="image"]{width:768px;max-width:none} [data-block="image"] img{width:100%;height:auto}'});
      const image=page.getByRole('img',{name:'Moving illustration'});
      await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).currentSrc)).toContain('.v2.original.');
      const selected=await image.evaluate(async img=>{await (img as HTMLImageElement).decode();return (img as HTMLImageElement).currentSrc;});
      const bytes=stored.get(publication.media_manifest.site_prefix + new URL(selected).pathname);
      expect((await sharp(bytes).metadata()).width).toBe(750);
      expect(bytes.length).toBeLessThan(stored.get(entry.source_key).length);
      await expect(page.locator('picture source')).toHaveCount(2);
      for(const source of await page.locator('picture source').all()) expect(await source.getAttribute('srcset')).toContain('750w');
      await page.screenshot({path:info.outputPath('full-resolution-768.png'),fullPage:true});
      expect((await harness.run()).report.reused).toBe(1);
      await fs.appendFile(path.join(harness.destination,'scripts/media-recipe.mjs'),'\n// Recipe cache qualification.\n');
      expect((await harness.run()).report.rendered).toBe(1);
    } finally { await harness.cleanup(); }
  },1,true,750);
});
