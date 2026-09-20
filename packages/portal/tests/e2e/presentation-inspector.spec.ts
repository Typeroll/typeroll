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
