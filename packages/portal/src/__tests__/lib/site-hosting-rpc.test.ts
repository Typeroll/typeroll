// The SITE_HOSTING seam across a real service binding in workerd, offline:
// the artifact object's `names()`/`read()` functions travel to the service
// and are called back, bytes arrive intact, and a refusal comes back as an
// envelope that siteHosting() turns into a ConnectionError with its code.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTING = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class SiteHosting extends WorkerEntrypoint {
  async describe() { return { api: 'typeroll-site-hosting', version: 1 }; }
  async publish(input) {
    const names = await input.files.names();
    const sizes = {};
    for (const name of names) sizes[name] = Array.from(await input.files.read(name));
    if (input.publication_id === 'refused') return { ok: false, error: { code: 'hosted_asset_limit', status: 413, message: 'Too big.', retryable: false } };
    return { ok: true, value: { publication_id: input.publication_id, digest: JSON.stringify(sizes), uploaded_files: names.length, unchanged: false } };
  }
}
export default { fetch: () => new Response('not found', { status: 404 }) };
`;

let mf: Miniflare, dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'typeroll-hosting-rpc-'));
  const entry = path.join(dir, 'portal-entry.ts');
  const seam = fileURLToPath(new URL('../../lib/publishing/site-hosting.ts', import.meta.url));
  writeFileSync(entry, `
import { env } from 'cloudflare:workers';
import { artifactFiles, setSiteHostingRuntime, siteHosting } from ${JSON.stringify(seam)};
setSiteHostingRuntime(() => env.SITE_HOSTING);
const site = { org: 'o', site: 's', uid: 'uid-00000001' };
export default { async fetch(request) {
  const id = new URL(request.url).searchParams.get('id');
  try {
    const value = await siteHosting().publish({ site, publication_id: id, files: artifactFiles({ 'index.html': new Uint8Array([60, 104, 49, 62]), 'a/b.bin': new Uint8Array([0, 255]) }) });
    return Response.json({ value });
  } catch (error) { return Response.json({ error: { message: error.message, status: error.status, code: error.code } }); }
} };
`);
  // The portal store is not needed here (the site ref is given); its Node-only backends are stubbed.
  const stubs: Plugin = { name: 'stubs', setup(b) {
    b.onResolve({ filter: /\/datastore(\.js)?$/ }, () => ({ path: fileURLToPath(new URL('../workers/datastore-stub.ts', import.meta.url)) }));
    // Only the seam's own code is under test; its store and error helpers are replaced by equivalents.
    b.onResolve({ filter: /^(\.\/connections|@typeroll\/shared|\.\.\/store\/sharded-store)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ loader: 'js', contents: {
      './connections': 'export class ConnectionError extends Error { constructor(message, status = 400, code, details) { super(message); this.status = status; this.code = code; this.details = details; } }',
      '@typeroll/shared': 'export const paths = { site: (org, site) => `organizations/${org}/sites/${site}` };',
      '../store/sharded-store': 'export const ownerPath = (org, site) => `site_owners/${org}:${site}`;',
    }[args.path] }));
  } };
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: path.join(dir, 'portal.js'),
    external: ['cloudflare:workers', 'node:*'], mainFields: ['module', 'main'], plugins: [stubs], logLevel: 'error' });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'portal', modules: true, script: readFileSync(path.join(dir, 'portal.js'), 'utf8'), compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
      serviceBindings: { SITE_HOSTING: { name: 'hosting', entrypoint: 'SiteHosting' } } },
    { name: 'hosting', modules: true, script: HOSTING, compatibilityDate: '2026-09-01' },
  ] } as never));
}, 60_000);
afterAll(async () => { await mf?.dispose(); rmSync(dir, { recursive: true, force: true }); });

it('passes the artifact as callbacks and unwraps the envelope', async () => {
  const response = await (await mf.dispatchFetch('http://portal/?id=pub-1')).json() as any;
  expect(response.value).toMatchObject({ publication_id: 'pub-1', uploaded_files: 2, unchanged: false });
  expect(JSON.parse(response.value.digest)).toEqual({ 'index.html': [60, 104, 49, 62], 'a/b.bin': [0, 255] });
});

it('turns a refusal into a ConnectionError with the service code', async () => {
  const response = await (await mf.dispatchFetch('http://portal/?id=refused')).json() as any;
  expect(response.error).toEqual({ message: 'Too big.', status: 413, code: 'hosted_asset_limit' });
});
