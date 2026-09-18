import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = `export const sdkVersion=1; export async function mount(root,sdk){
const input=document.createElement('input'); input.setAttribute('aria-label','Title'); input.value=(await sdk.configuration.read()).title;
const button=document.createElement('button');button.textContent='Save';
input.oninput=()=>sdk.setDirty(true);button.onclick=async()=>{try{await sdk.request('/admin/status');await sdk.configuration.save({title:input.value});sdk.notify('Saved');}catch(e){sdk.notify(e.message,'error')}};
root.append(input,button);return ()=>{window.unmounted=true;};}`;
const hash = createHash('sha256').update(source).digest('hex');
const bundle = await build({entryPoints:['packages/portal/src/lib/extensions/native-admin-client.ts'],bundle:true,format:'esm',write:false,platform:'browser'});
const output = 'temp/native-admin-browser'; await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
try {
 for (const width of [375,1280]) {
  const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let config={title:'Example'}, changed=false, corrupt=false, denied=false, calls=0;
  await page.route('https://portal.example.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('admin-session'))return route.fulfill({status:denied?403:200,json:denied?{error:'Access denied'}:{issuer:url.origin,org_id:changed?'other':'org',site_id:'site',installation_id:'install',version:'1.0.0',permission:'admin',token:'synthetic',expires_at:Date.now()+300000,native:{sdk_version:1,script_url:'https://app.example.test/module.js',script_sha256:hash,api_base_url:'https://app.example.test/v1'}}});
   if(url.pathname.startsWith('/api/')){if(route.request().method()==='PATCH')config=route.request().postDataJSON().config;return route.fulfill({json:{config}});}
   return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><title>Native app QA</title><style>body{font:18px system-ui;margin:20px}input,button{box-sizing:border-box;padding:12px;max-width:100%;margin:8px 0;display:block}</style><h1>App settings</h1><div id="root" data-site-id="site" data-installation-id="install" data-page-id="settings"></div><a href="/app/sites/site">Leave</a>'});
  });
  await page.route('https://app.example.test/**',async route=>{
   const req=route.request();
   if(req.url().endsWith('module.js'))return route.fulfill({contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:source+(corrupt?'//tampered':'')});
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'https://portal.example.test','Access-Control-Allow-Headers':'Authorization, Content-Type'}});
   assert.equal(req.headers().authorization,'Bearer synthetic');assert.equal(req.headers().cookie,undefined);calls++;
   return route.fulfill({json:{ok:true},headers:{'Access-Control-Allow-Origin':'https://portal.example.test'}});
  });
  const mount=async()=>{await page.goto('https://portal.example.test/app/sites/site/extensions/install/settings');await page.evaluate(async code=>{const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));const m=await import(url);URL.revokeObjectURL(url);window.dispose=await m.mountNativeAdmin(document.getElementById('root'));},bundle.outputFiles[0].text);};
  await mount();assert.equal(await page.locator('iframe').count(),0);await page.getByLabel('Title').fill('Updated');
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('link',{name:'Leave'}).click();assert.match(page.url(),/settings$/);
  await page.getByRole('button',{name:'Save'}).click();await page.getByRole('status').filter({hasText:'Saved'}).waitFor();assert.equal(config.title,'Updated');assert.equal(calls,1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${output}/native-${width}.png`,fullPage:true});
  changed=true;await page.getByRole('button',{name:'Save'}).click();await page.getByRole('status').filter({hasText:'App context changed'}).waitFor();assert.equal(calls,1);
  await page.evaluate(()=>window.dispose());assert.equal(await page.evaluate(()=>window.unmounted),true);
  changed=false;corrupt=true;await mount();await page.getByRole('alert').filter({hasText:'integrity'}).waitFor();assert.equal(await page.locator('input').count(),0);
  corrupt=false;denied=true;await mount();await page.getByRole('alert').filter({hasText:'Access denied'}).waitFor();assert.deepEqual(errors,[]);
  await context.close();
 }
 console.log('Native portal: verified modules, direct DOM, save, dirty navigation, context revocation, cleanup and mobile/desktop passed.');
} finally {await browser.close();}
