import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const qa = require('../../../mcp-server/workspace-templates/scripts/typeroll/browser.cjs');

test('starter QA opens only the named preview and reports layout problems', async ({ page }) => {
  await page.route('https://qa.invalid/**', route => route.fulfill({ contentType:'text/html', body: route.request().url().includes('/inner')
    ? '<html><head><title>Inner page</title></head><body><h1>Example</h1><p style="width:3000px">Overflow</p></body></html>'
    : '<html><body><iframe title="Advertisement" src="/ad"></iframe><iframe title="Site preview"></iframe><script>setTimeout(()=>document.querySelector(\'[title="Site preview"]\').src="/inner",50)</script></body></html>' }));
  await qa.open(page, 'https://qa.invalid/wrapper');
  await qa.settle(page);
  expect(page.url()).toBe('https://qa.invalid/inner');
  const result = await qa.inspect(page);
  expect(result.title).toBe('Inner page');
  expect(result.h1).toBe(1);
  expect(result.overflow).toBe(true);
});

test('starter QA does not mistake an ordinary content iframe for its page', async ({ page }) => {
  await page.route('https://qa.invalid/**', route => route.fulfill({ contentType:'text/html', body:'<html><head><title>Hosted page</title></head><body><h1>Page</h1><iframe title="Video" src="about:blank"></iframe></body></html>' }));
  await qa.open(page, 'https://qa.invalid/hosted');
  expect(page.url()).toBe('https://qa.invalid/hosted');
  expect((await qa.inspect(page)).title).toBe('Hosted page');
});
