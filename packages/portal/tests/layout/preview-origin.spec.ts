import { test, expect, chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { realOriginPreviewHeaders } from '../../src/lib/preview-origin';
import { previewEmbedHelpScript } from '../../src/lib/preview-embed-help';
import { buildExtensionPreviewShell, extensionPreviewShellHeaders } from '../../src/lib/extensions/preview-shell';

// Real HTTP responses exercise frame-ancestors through every ancestor. No provider network.
for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
  test(`${engine}: partner forms work on a separate origin, with honest fallback help`, async () => {
    const browser = await browserType.launch();
    let origin = ''; let portal = '';
    process.env.PORTAL_PUBLIC_URL = 'https://app.example.com';
    process.env.PREVIEW_ORIGIN_TEMPLATE = 'https://{scope}.preview-example.net';
    const sandbox = realOriginPreviewHeaders()['Content-Security-Policy'].split(';')[0];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, origin);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/provider') {
        res.setHeader('Content-Security-Policy', url.searchParams.has('deny') ? "frame-ancestors 'none'" : 'frame-ancestors *');
        res.end('<!doctype html><label>Name <input></label><button>Continue</button><script>parent.postMessage("provider-ready","*")</script>');
      } else if (url.pathname === '/portal') {
        res.end(`<!doctype html><title>Portal</title><iframe title="Preview" style="width:100%;height:700px" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" src="${origin}/frame"></iframe>`);
      } else if (url.pathname === '/shell') {
        for (const [name, value] of Object.entries(extensionPreviewShellHeaders())) res.setHeader(name, value);
        res.end(buildExtensionPreviewShell({ pageUrl: origin + '/frame', realOrigin: true, siteId: 'site', bridgeId: '12345678-1234-1234-1234-123456789abc', rootPath: '/', storageScope: 'test', carriedQuery: {} }));
      } else {
        const opaque = url.searchParams.has('opaque');
        res.setHeader('Content-Security-Policy', `${opaque ? sandbox.replace(' allow-same-origin', '') : sandbox}; frame-ancestors 'self' ${portal}`);
        res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;margin:20px}iframe{width:100%;border:1px solid #ddd;height:120px}</style><h1>Partner form preview</h1><iframe title="Allowed form" src="${portal}/provider"></iframe><iframe title="Denied form" style="height:0" src="${portal}/provider?deny=1"></iframe><script>window.partnerLoaded=false;addEventListener('message',e=>{if(e.data==='provider-ready')window.partnerLoaded=true});</script><script>${previewEmbedHelpScript()}</script>`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${port}`; portal = `http://localhost:${port}`;
    const context = await browser.newContext(); const page = await context.newPage(); page.on("pageerror", error => console.error(error.message));
    try {
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(portal + '/portal');
        const preview = page.frameLocator('iframe[title="Preview"]');
        await expect(preview.frameLocator('iframe[title="Allowed form"]').getByRole('button', { name: 'Continue' })).toBeVisible();
        await expect(preview.getByText('No visible embed')).toBeVisible();
        await expect(preview.getByText(/Typeroll cannot confirm/).last()).toBeVisible();
        expect(await page.frames()[1].evaluate(() => { try { return parent.document.title; } catch { return 'isolated'; } })).toBe('isolated');
        const dimensions = await preview.locator('body').evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
        await page.screenshot({ path: `/tmp/typeroll-preview-${engine}-${width}.png`, fullPage: true });
      }
      await page.goto(origin + '/frame');
      await expect(page.frameLocator('iframe[title="Allowed form"]').getByRole('button', { name: 'Continue' })).toBeVisible();
      await page.goto(origin + '/shell');
      await expect(page.frameLocator('#preview').frameLocator('iframe[title="Allowed form"]').getByRole('button', { name: 'Continue' })).toBeVisible();
      await page.goto(origin + '/frame?opaque=1');
      await expect(page.getByText('No visible embed')).toBeVisible();
      // Firefox currently accepts this wildcard with an opaque ancestor;
      // Chromium/WebKit reproduce the reported failure. Isolation is required everywhere.
      expect(await page.evaluate(() => { try { localStorage.getItem('test'); return false; } catch { return true; } })).toBe(true);
      if (engine !== 'firefox') expect(await page.evaluate(() => (window as any).partnerLoaded)).toBe(false);
    } finally {
      await context.close(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
      delete process.env.PREVIEW_ORIGIN_TEMPLATE; delete process.env.PORTAL_PUBLIC_URL;
    }
  });
}
