// The document store in real workerd with Durable Object SQLite, offline.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlStore } from '../../lib/store/sql-store';
import { durableObjectTransport } from '../../lib/store/durable-object';

let mf: Miniflare, dir: string, store: SqlStore;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'typeroll-do-'));
  const entry = fileURLToPath(new URL('../workers/document-store-worker.ts', import.meta.url));
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: path.join(dir, 'worker.js'), external: ['cloudflare:workers'], logLevel: 'silent' });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: readFileSync(path.join(dir, 'worker.js'), 'utf8'), compatibilityDate: '2026-09-01',
    durableObjects: { STORE: { className: 'DocumentStore', useSQLite: true } } } as never));
  const call = async (method: string, ...args: unknown[]) => { const response = await mf.dispatchFetch('http://store/', { method: 'POST', body: JSON.stringify({ method, args }) }); const text = await response.text(); if (!response.ok) throw new Error(text.slice(0, 500)); return JSON.parse(text); };
  const stub = new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => call(method, ...args) }) as never;
  let id = 0;
  store = new SqlStore(durableObjectTransport(stub), () => `doc${++id}`);
}, 60_000);
afterAll(async () => { await mf?.dispose(); rmSync(dir, { recursive: true, force: true }); });

it('keeps the store contract in a Durable Object', async () => {
  await store.setDoc('organizations/o/sites/s', { name: 'S', nested: { a: 1 } });
  await store.updateDoc('organizations/o/sites/s', { nested: { b: 2 } });
  expect(await store.getDoc('organizations/o/sites/s')).toEqual({ id: 's', name: 'S', nested: { a: 1, b: 2 } });
  const created = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createDocIfMissing('claims/x', { by: i })));
  expect(created.filter(Boolean)).toHaveLength(1);
  await store.setDoc('counters/c', { value: 0 });
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (;;) {
      const current = await store.getDoc<{ value: number }>('counters/c');
      if (await store.compareAndUpdateDoc<{ value: number }>('counters/c', doc => doc.value === current!.value, { value: current!.value + 1 })) return;
    }
  }));
  expect(await store.getDoc('counters/c')).toMatchObject({ value: 10 });
  expect((await store.listDocs('claims')).map(doc => doc.id)).toEqual(['x']);
}, 60_000);
