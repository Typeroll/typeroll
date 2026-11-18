import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';

for (const width of [390, 768, 1280]) test(`PDF upload, verification retry and public sharing at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({width,height:900});
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as any).__copiedPublicUrl = value; } } }); });
  const id='public-pdf-fixture', base=`/api/sites/default/media/${id}`;
  const publicUrl='https://media.example.test/media/anonymous/1234567890abcdef-report.pdf';
  const media:any={id,filename:'report.pdf',mime_type:'application/pdf',size_bytes:30,sha256:'a'.repeat(64),cdn_url:`http://127.0.0.1:4322${base}/content`,created_at:'2026-01-01',storage:{state:'ready',provider:'organization_r2'}};
  await page.route('**/api/sites/default/media/upload-status',r=>r.fulfill({json:{enabled:true}}));
  await page.route('**/api/sites/default/media/preparation',r=>r.fulfill({json:{state:'waiting',completed:0,total:3,error:'Background image preparation needs an engine update.'}}));
  await page.route('**/api/sites/default/media/upload-url',r=>r.fulfill({json:{uploadUrl:'https://upload.example.test/file',mediaId:id,cdnUrl:media.cdn_url,finalizeUrl:`${base}/finalize`}}));
  await page.route('https://upload.example.test/file',r=>r.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'}}));
  await page.route(`**${base}/finalize`,r=>r.fulfill({json:{ok:true,result:{sha256:media.sha256}}}));
  await page.route(`**${base}`,r=>r.fulfill({json:media}));
  let attempts=0;
  await page.route(`**${base}/publish`,async r=> {
    if (++attempts===1) {
      media.file_publication={state:'pending',url:publicUrl,sha256:media.sha256,key:'media/anonymous/1234567890abcdef-report.pdf',verified_at:null};
      return r.fulfill({status:409,json:{error:'The public address could not be verified. Retry Publish PDF.'}});
    }
    media.file_publication={state:'public',url:publicUrl,sha256:media.sha256,key:'media/anonymous/1234567890abcdef-report.pdf',verified_at:'2026-01-01'};
    await r.fulfill({json:{state:'public',public_url:publicUrl}});
  });
  await gotoReady(page,'/app/sites/default/media');
  await page.locator('input[type=file]').setInputFiles({name:'report.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic fixture\n%%EOF')});
  await page.getByRole('button',{name:'View details for report.pdf'}).click();
  const dialog=page.getByRole('dialog',{name:'Media: report.pdf'});
  await expect(dialog.getByText('Private',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Copy public URL'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Publish PDF',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be verified');
  await expect(dialog.getByText('Public copy awaiting verification',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Copy public URL',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Publish PDF',exact:true}).click();
  await expect(dialog.getByRole('link',{name:'Open public file',exact:true})).toHaveAttribute('href',publicUrl);
  await expect(dialog.getByText('Public',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Copy public URL',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__copiedPublicUrl)).toBe(publicUrl);
  await dialog.getByRole('button',{name:'Copy public URL',exact:true}).scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(el=>el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeInViewport();
  await page.screenshot({path:info.outputPath(`public-pdf-${width}.png`)});
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Copy public URL for report.pdf'}).isVisible();
});
