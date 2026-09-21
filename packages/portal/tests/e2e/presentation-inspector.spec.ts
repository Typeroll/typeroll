import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('inspector keeps content visible, collapses presentation, and resets an exact size', async ({page}, info) => {
  const file=path.join(os.tmpdir(),'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/pages/presentation-inspector.json');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({id:'presentation-inspector',title:'Inspector',slug:'presentation-inspector',status:'draft',content_mode:'blocks',blocks:[{id:'h',type:'core/heading',data:{text:'Inspector heading',level:'h2',font_size_px:24}}]}));
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('/app/sites/default/pages/presentation-inspector',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Structure',exact:true}).click();
    await page.getByRole('button',{name:'Edit Inspector heading',exact:true}).click();
    await expect(page.getByLabel('Heading text',{exact:true})).toBeVisible();
    const size=page.getByLabel('Text size (px)',{exact:true});
    await expect(size).toBeHidden();
    await expect(page.locator('details.block-field-settings[open]')).toHaveCount(0);
    await page.getByText('Advanced settings',{exact:true}).click();
    await expect(size).toHaveValue('24');
    expect(await page.frameLocator('iframe[title="Preview"]').locator('html').evaluate(() => window.innerWidth)).toBe(1280);
    await size.fill('20');
    const heading=page.frameLocator('iframe[title="Preview"]').getByRole('heading',{name:'Inspector heading',exact:true});
    await expect(heading).toHaveCSS('font-size','20px');
    await page.getByRole('button',{name:'Reset text size (px)',exact:true}).click();
    await expect(size).toHaveValue('');
    await expect(heading).not.toHaveCSS('font-size','20px');
    await page.locator('button[title*="wide starts at 1536px"]').first().click();
    expect(await page.frameLocator('iframe[title="Preview"]').locator('html').evaluate(() => window.innerWidth)).toBe(1536);
    await page.screenshot({path:info.outputPath('inspector-1440.png')});
  } finally { rmSync(file,{force:true}); }
});

test('image framing is editable in the native inspector and updates the real preview', async ({page}) => {
  const file=path.join(os.tmpdir(),'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/pages/framing-inspector.json');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({id:'framing-inspector',title:'Image framing',slug:'framing-inspector',status:'draft',content_mode:'blocks',blocks:[{id:'illustration',type:'core/image',data:{src:'https://media.example.test/inspector.svg',alt:'Inspector illustration',original_width:600,original_height:150}}]}));
  await page.route('https://media.example.test/inspector.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="150"><rect width="600" height="150" fill="#cde5df"/></svg>'}));
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('/app/sites/default/pages/framing-inspector',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Structure',exact:true}).click();
    await page.getByRole('button',{name:'Edit inspector.svg',exact:true}).click();
    await page.getByText('Advanced settings',{exact:true}).click();
    const scale=page.getByLabel('Image scale inside frame (%)',{exact:true});
    await expect(scale).toHaveValue('100'); await scale.fill('120');
    const preview=page.frameLocator('iframe[title="Preview"]');
    await expect(preview.locator('[data-block="image"]')).toHaveCSS('--scale_percent','120');
    const image=preview.locator('.block-image-frame img');
    const frame=preview.locator('.block-image-frame');
    await expect.poll(async()=>{const a=await image.boundingBox(),b=await frame.boundingBox();return a&&b?Math.round(100*a.width/b.width):0}).toBe(120);
    await page.getByRole('button',{name:'Reset image scale inside frame (%)',exact:true}).click();
    await expect(scale).toHaveValue('100');
    await expect(preview.locator('[data-block="image"]')).toHaveCSS('--scale_percent','100');
  } finally { rmSync(file,{force:true}); }
});
