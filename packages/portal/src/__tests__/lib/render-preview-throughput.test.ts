import { afterEach, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { renderPreviewBySlug } from '../../lib/render-preview';

afterEach(() => vi.restoreAllMocks());

it('reads route collections once and overlaps independent preview inputs without reusing stale content', async () => {
  makeTmpFixtures(); await resetDatastore();
  const org = 'preview-org', site = 'preview-site', version = MAIN_VERSION_ID;
  await getStore().setDoc(paths.site(org, site), { name: 'Preview performance' });
  await getStore().setDoc(paths.settings(org, site, version), { site_name: 'Preview performance' });
  await getStore().setDoc(paths.page(org, site, 'home', version), { title: 'First title', slug: 'home', path: '/', content_type: 'page', content_mode: 'html', html_content: '<p>Saved content</p>', status: 'published' });
  const pages = vi.spyOn(vstore, 'pages');
  const types = vi.spyOn(vstore, 'contentTypes');
  const originalSettings = vstore.settings;
  const originalPartials = vstore.partials;
  let settingsStarted = false, partialsStarted = false;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(vstore, 'settings').mockImplementation(async (...args) => {
    settingsStarted = true;
    if (partialsStarted) release();
    await barrier;
    return originalSettings(...args);
  });
  vi.spyOn(vstore, 'partials').mockImplementation(async (...args) => {
    partialsStarted = true;
    if (settingsStarted) release();
    await barrier;
    return originalPartials(...args);
  });
  const html = await renderPreviewBySlug(org, site, [], version);
  expect(html).toContain('<title>First title</title>');
  expect(pages).toHaveBeenCalledTimes(1);
  expect(types).toHaveBeenCalledTimes(1);
  await getStore().updateDoc(paths.page(org, site, 'home', version), { title: 'Changed title' });
  expect(await renderPreviewBySlug(org, site, [], version)).toContain('<title>Changed title</title>');
  expect(pages).toHaveBeenCalledTimes(2);
});

it('revalidates the real sharded preview route without retransferring unchanged Page bodies', async () => {
  const { SqlDocumentEngine } = await import('../../lib/store/sql-engine');
  const { nodeSqliteDriver } = await import('../../lib/store/node-sqlite');
  const { localTransport } = await import('../../lib/store/sql-store');
  const { cloudflareStore } = await import('../../lib/runtime/cloudflare-store');
  const { setRuntimeStore } = await import('../../lib/datastore');
  const engines = new Map<string, InstanceType<typeof SqlDocumentEngine>>();
  const transfers: number[] = [];
  // Exercise the deployed composition, including the timing decorator and
  // request-local Durable Object stubs, not just the uninstrumented store.
  const store = cloudflareStore({ STORE: {
    jurisdiction: name => { expect(name).toBe('eu'); return namespace; },
    idFromName: name => name,
    get: name => namespace.get(name),
  } });
  const namespace: import('../../lib/runtime/cloudflare-store').DurableObjectNamespaceLike = {
    jurisdiction: () => namespace,
    idFromName: (name: string) => name,
    get: (name: unknown) => {
      const key = String(name);
      if (!engines.has(key)) engines.set(key, new SqlDocumentEngine(nodeSqliteDriver()));
      const transport = localTransport(engines.get(key)!);
      for (const method of ['list', 'listVersioned'] as const) {
        const read = transport[method]!;
        (transport as any)[method] = async (...args: any[]) => {
          const result = await (read as any)(...args);
          if (args[0].endsWith('/pages')) transfers.push(JSON.stringify(result).length);
          return result;
        };
      }
      return transport;
    },
  };
  const org = 'cached-preview-org', site = 'cached-preview-site', version = MAIN_VERSION_ID;
  setRuntimeStore(() => store);
  try {
    await store.setDoc(paths.site(org, site), { name: 'Cache test' });
    await store.setDoc(paths.settings(org, site, version), { site_name: 'Cache test' });
    for (let i = 0; i < 50; i++) await store.setDoc(paths.page(org, site, `p${i}`, version), {
      title: `Page ${i}`, slug: `p${i}`, path: `/p${i}/`, content_type: 'page', content_mode: 'html', html_content: `<p>${'x'.repeat(10000)}</p>`, status: 'published',
    });
    expect(await renderPreviewBySlug(org, site, ['p0'], version)).toContain('<title>Page 0</title>');
    expect(await renderPreviewBySlug(org, site, ['p1'], version)).toContain('<title>Page 1</title>');
    expect(transfers[0]).toBeGreaterThan(500000);
    expect(transfers[1]).toBeLessThan(100);
    await store.updateDoc(paths.page(org, site, 'p1', version), { title: 'Updated immediately' });
    expect(await renderPreviewBySlug(org, site, ['p1'], version)).toContain('<title>Updated immediately</title>');
    await store.deleteDoc(paths.page(org, site, 'p1', version));
    expect(await renderPreviewBySlug(org, site, ['p1'], version)).toBeNull();
    process.stdout.write(JSON.stringify({ benchmark: 'preview-route-page-library', cold_bytes: transfers[0], next_click_bytes: transfers[1] }) + '\n');
  } finally { setRuntimeStore(null); }
});
