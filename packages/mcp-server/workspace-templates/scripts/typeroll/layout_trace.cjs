// Explain vertical spacing: computed margin/padding/gap of every ancestor of a selector and of the next
// section down to its first heading. Works on a signed preview link (reads the inner frame) or a public URL.
// usage: node layout_trace.js <url> [width=390] [selector=h1]
const qa = require('./browser.cjs');
const { chromium } = qa;
(async () => {
  const [,, url, width = '390', sel = 'h1'] = process.argv;
  const b = await chromium.launch();
  const p = await b.newPage({viewport: {width: +width, height: 900}});
  await qa.open(p, url);
  const f = p.mainFrame();
  try { console.log(await f.evaluate((sel) => {
    const out = [];
    const show = (lab, el) => {
      if (!el) return;
      const c = getComputedStyle(el), r = el.getBoundingClientRect();
      out.push(`${lab} <${el.tagName.toLowerCase()} ${el.getAttribute('data-block') || String(el.className).slice(0, 40)}> top=${Math.round(r.top)} h=${Math.round(r.height)} margin=${c.marginTop}/${c.marginBottom} padding=${c.paddingTop}/${c.paddingBottom} gap=${c.rowGap} radius=${c.borderRadius}`);
    };
    const target = document.querySelector(sel);
    if (!target) throw Error('Selector not found');
    const sec = target.closest('[data-block="section"]') || target;
    const chain = []; for (let a = target; a && a !== document.body; a = a.parentElement) chain.push(a);
    chain.reverse().forEach((x, i) => show('ancestor' + i, x));
    for (let s = sec.nextElementSibling; s; s = s.nextElementSibling) {
      show('next', s);
      const h = s.querySelector('h1,h2,h3');
      if (h) { const ch = []; for (let q = h; q && q !== s; q = q.parentElement) ch.push(q); ch.reverse().forEach((x, i) => show('inside' + i, x)); break; }
    }
    show('header', document.querySelector('header'));
    return out.join('\n');
  }, sel));
  } finally { await b.close(); }
})().catch(qa.fail);
