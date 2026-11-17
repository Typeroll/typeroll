import { afterEach, expect, it } from 'vitest';
import { paths, type Page } from '@typeroll/shared';
import { setRuntimeStore } from '../../lib/datastore';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { localTransport, type StoreTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { ShardedStore } from '../../lib/store/sharded-store';
import { applyContentWrite } from '../../lib/content-write';

const ctx = { orgId: 'test-org', siteId: 'test-site', versionId: 'main' };
afterEach(() => setRuntimeStore(null));

it('saves a structured image field without work proportional to the page body', async () => {
  const engines = new Map<string, SqlDocumentEngine>();
  const calls: Array<{ method: string; path: string }> = [];
  const store = new ShardedStore({ transport: name => {
    if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
    const transport = localTransport(engines.get(name)!);
    return new Proxy(transport, { get(target, key: keyof StoreTransport) {
      const fn = target[key];
      if (typeof fn !== 'function') return fn;
      return (...args: any[]) => {
        calls.push({ method: key, path: typeof args[0] === 'string' ? args[0] : '' });
        return (fn as Function).apply(target, args);
      };
    } });
  } }, () => 'unused-id');
  setRuntimeStore(() => store);
  await store.setDoc(paths.contentType(ctx.orgId, ctx.siteId, 'article', 'main'), {
    name: 'Article', slug: 'article', route_template: '/articles/{slug}/',
    fields: [{ name: 'featured_image', type: 'image' }, { name: 'featured_image_alt', type: 'text' }],
    template: 'article',
  });
  await store.setDoc(paths.pageTemplate(ctx.orgId, ctx.siteId, 'article', 'main'), { name: 'Article', blocks: [] });
  const pagePath = paths.page(ctx.orgId, ctx.siteId, 'example', 'main');
  const blocks = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, type: 'core/paragraph', data: { text: `Paragraph ${i}` } }));
  await store.setDoc(pagePath, { title: 'Example', slug: 'example', content_type: 'article', status: 'published', content_mode: 'blocks', blocks, fields: { featured_image: 'https://example.test/old.jpg', featured_image_alt: 'Old' } });
  calls.length = 0;
  const start = performance.now();
  const result = await applyContentWrite(ctx, { kind: 'page', id: 'example' }, { fields: { featured_image: 'https://example.test/new.jpg', featured_image_alt: 'New' } }, { save: true, updatedBy: 'test' });
  const saveCalls = [...calls];
  process.stdout.write(JSON.stringify({ benchmark: 'structured-field-save', calls: saveCalls.length, byMethod: Object.fromEntries(['get', 'getMany', 'list', 'commit'].map(method => [method, saveCalls.filter(call => call.method === method).length])), local_ms: Math.round(performance.now() - start) }) + '\n');
  expect(result.committed).toBe(true);
  // Previous implementation: 50 transport calls, including repeated template
  // reads and redirect scans. This is a network-round-trip budget, not a
  // wall-clock assertion on a machine running unrelated tests.
  expect(saveCalls.length).toBeLessThanOrEqual(18);
  expect(saveCalls.some(call => call.path.includes('/page_templates/'))).toBe(false);
  expect(saveCalls.some(call => call.path.includes('/redirects'))).toBe(false);
  const page = await store.getDoc<Page>(pagePath);
  expect(page?.fields).toEqual({ featured_image: 'https://example.test/new.jpg', featured_image_alt: 'New' });
  expect(page?.blocks).toEqual(blocks);
  expect(saveCalls.filter(call => call.path.includes('/media'))).toEqual([]);

  // A structured field can also be part of a route: that change must still
  // create the same redirect as a slug edit, despite the fast field path.
  await store.updateDoc(paths.contentType(ctx.orgId, ctx.siteId, 'article', 'main'), {
    route_template: '/{category}/{slug}/',
    fields: [{ name: 'featured_image', type: 'image' }, { name: 'featured_image_alt', type: 'text' }, { name: 'category', type: 'text' }],
  });
  await store.updateDoc(pagePath, { fields: { ...page!.fields, category: 'old' } });
  const moved = await applyContentWrite(ctx, { kind: 'page', id: 'example' }, { fields: { category: 'new' } }, { save: true, updatedBy: 'test' });
  expect(moved.auto_redirects).toEqual([{ from_path: '/old/example', to_path: '/new/example', status_code: 301 }]);
});
