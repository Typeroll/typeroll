// Read-only component rhythm QA. Deliberate exceptions require visual review.
const { chromium } = require('playwright');
const fs = require('node:fs');
async function main() {
  const origin = new URL(process.argv[2]);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw Error('Use an http(s) origin without credentials.');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let paths;
    if (process.argv[3]) paths = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    else {
      const response = await page.request.get(new URL('/sitemap.xml', origin).href);
      if (!response.ok()) throw Error(`Sitemap returned ${response.status()}`);
      const xml = await response.text();
      if (xml.includes('<sitemapindex')) throw Error('Provide paths.json for a sitemap index.');
      paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(/&amp;/g,'&'));
    }
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || new URL(p,origin).origin !== origin.origin)) throw Error('Provide a nonempty array of same-origin paths.');
    let count = 0;
    for (const width of [375,768,1280]) {
      await page.setViewportSize({width,height:900});
      for (const path of [...new Set(paths)]) {
        await page.goto(new URL(path,origin).href,{waitUntil:'domcontentloaded'});
        await page.evaluate(()=>document.fonts.ready);
        const findings=await page.evaluate(()=>{
          const found=[];
          const roots=document.querySelectorAll('[data-block="container"], .block-section-inner, [data-block="post_card"] [class*="postcard-body"], [data-block="icon_box"]');
          for(const root of roots) {
            const visible=[...root.children].filter(e=>e.getBoundingClientRect().height>0);
            const first=visible[0];
            const heading=first?.matches('h1,h2,h3,h4,h5,h6')?first:first?.matches('[data-block="heading"],hgroup')?first.querySelector('h1,h2,h3,h4,h5,h6'):null;
            if(heading && parseFloat(getComputedStyle(heading).marginBlockStart)>1) found.push({kind:'opening_heading_margin',block:root.closest('[data-block]')?.getAttribute('data-block'),text:heading.textContent.slice(0,80),px:parseFloat(getComputedStyle(heading).marginBlockStart)});
            if(root.closest('[data-block="post_card"]') && visible.length) {
              const rect=root.getBoundingClientRect(),top=visible[0].getBoundingClientRect().top-rect.top,bottom=rect.bottom-visible.at(-1).getBoundingClientRect().bottom;
              if(top>bottom+4) found.push({kind:'asymmetric_card',top:Math.round(top),bottom:Math.round(bottom)});
            }
          }
          return found;
        });
        count+=findings.length;
        if(findings.length) console.log(JSON.stringify({path:new URL(path,origin).pathname,width,findings}));
      }
    }
    console.log(JSON.stringify({pages:paths.length,widths:[375,768,1280],findings:count}));
    process.exitCode=count?1:0;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=2;});
