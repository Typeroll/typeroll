import { expect, test } from '@playwright/test';

test('extension settings hydrates without React errors', async ({ page }) => {
  const hydrationErrors: string[] = [];
  const hydrationErrorPattern =
    /hydration|text content did not match|react error #(423|425)/i;

  page.on('console', (message) => {
    if (message.type() === 'error' && hydrationErrorPattern.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (hydrationErrorPattern.test(error.message)) {
      hydrationErrors.push(error.message);
    }
  });

  await page.goto('/app/sites/default/settings/extensions');
  await expect(
    page.getByRole('heading', { name: 'Extensions', exact: true }),
  ).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(hydrationErrors).toEqual([]);
});

for (const width of [375,1280]) test(`pending releases require a reviewed per-site activation at ${width}px`,async({page},info)=>{
  const { authenticatePersona } = await import('./helpers/auth');
  await authenticatePersona(page,'owner'); await page.setViewportSize({width,height:900});
  let activated=false;const patches:unknown[]=[];const deployments:string[]=[];
  page.on('request',request=>{if(request.url().includes('/deploy'))deployments.push(request.url());});
  await page.route('**/api/extensions/catalog',route=>route.fulfill({json:{extensions:[]}}));
  await page.route('**/api/sites/e2e-core-site/extensions',route=>route.fulfill({json:{extensions:[{
    id:'sample-installation',extension_id:'com.example.sample',developer_org_id:'provider',version:activated?'2.0.0':'1.0.0',status:'enabled',
    granted_scopes:['content:read'],manifest:{name:'Example app',developer:{name:'Example'},permissions:[{scope:'content:read',reason:'Read public pages'}]},
    ...(!activated?{pending_activation_version:'2.0.0',pending_activation_manifest:{permissions:[{scope:'content:read',reason:'Read public pages'},{scope:'email:send',reason:'Send requested edit links'}],config_schema:{required:['edit_page_url']}}}:{}),
  }]}}));
  await page.route('**/api/sites/e2e-core-site/extensions/sample-installation',async route=>{
    patches.push(route.request().postDataJSON());activated=true;await route.fulfill({json:{installation:{},redeploy_required:true}});
  });
  await page.goto('/app/sites/e2e-core-site/settings/extensions');
  await page.getByText('Review update to 2.0.0').click();
  const form=page.locator('form').filter({has:page.getByRole('button',{name:'Activate for this site'})});
  await expect(form.locator('input[value="content:read"]')).toBeChecked();
  await expect(form.locator('input[value="email:send"]')).not.toBeChecked();
  expect((await form.locator('input[value="email:send"]').boundingBox())!.width).toBeLessThan(24);
  await form.locator('textarea').fill('{"edit_page_url":"https://example.test/edit/"}');
  await form.locator('input[value="email:send"]').check();
  await page.screenshot({path:info.outputPath(`activation-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await form.getByRole('button',{name:'Activate for this site'}).click();
  await expect(page.getByText('Example app updated for this site. Check its connection and settings before publishing updated pages.')).toBeVisible();
  expect(patches).toEqual([{version:'2.0.0',config:{edit_page_url:'https://example.test/edit/'},granted_scopes:['content:read','email:send']}]);
  expect(deployments).toEqual([]);
});
