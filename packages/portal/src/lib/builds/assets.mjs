import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Prefetch through the frozen renderer's URL and integrity guards, without media or provider credentials. */
export async function prepareAssets(root) {
  const dir = path.join(root, '.typeroll-runner');
  const publication = JSON.parse(await fs.readFile(path.join(root, 'publication.json'), 'utf8'));
  const entries = []; let total = 0;
  if (publication.extensions?.installations?.some(installation => installation.components?.some(component => component.render_mode === 'bundled_component'))) {
    const bundled = path.join(dir, 'extension-preparation.mjs');
    await build({ entryPoints: [path.join(root, 'scripts/source/extensions/assets.ts')], outfile: bundled,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@typeroll/shared': path.join(root, 'packages/shared/src/index.ts') } });
    const { vendorExtensionAssets } = await import(pathToFileURL(bundled).href);
    await vendorExtensionAssets(path.join(dir, 'extension-output'), publication.extensions, async (url, options) => {
      const response = await fetch(url, options);
      if (!response.ok) return response;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('extension_asset_limit'); chunks.push(Buffer.from(chunk)); }
      total += size; if (total > 128 * 1024 * 1024 || entries.length >= 20000) throw Error('extension_assets_limit');
      const bytes = Buffer.concat(chunks), hash = digest(bytes);
      const hostname = new URL(url).hostname;
      // These addresses were resolved during the trusted preparation stage. Reusing
      // them permits the frozen URL guard to run again with rendering offline.
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      await fs.writeFile(path.join(dir, `extension-${hash}`), bytes);
      entries.push({ url: String(url), hostname, addresses, sha256: hash });
      return new Response(bytes, { status: response.status, headers: response.headers });
    });
  }
  await fs.writeFile(path.join(dir, 'extension-cache.json'), JSON.stringify(entries), { flag: 'wx' });
}

/** Only exact preverified URLs are served locally; other requests still meet the network sandbox. */
export async function installAssetCache(root) {
  const dir = path.join(root, '.typeroll-runner');
  const entries = JSON.parse(await fs.readFile(path.join(dir, 'extension-cache.json'), 'utf8'));
  const cache = new Map(), addresses = new Map();
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || new URL(entry.url).hostname !== entry.hostname || !Array.isArray(entry.addresses)) throw Error('extension_cache_invalid');
    const bytes = await fs.readFile(path.join(dir, `extension-${entry.sha256}`));
    if (digest(bytes) !== entry.sha256) throw Error('extension_cache_integrity');
    cache.set(entry.url, bytes); addresses.set(entry.hostname, entry.addresses);
  }
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup;
  globalThis.fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bytes = cache.get(url);
    if (!bytes || (options?.method && options.method !== 'GET')) return originalFetch(input, options);
    return new Response(bytes);
  };
  dns.lookup = async (hostname, options) => {
    const saved = addresses.get(hostname);
    if (!saved) return originalLookup(hostname, options);
    const family = typeof options === 'number' ? options : options?.family;
    const matching = saved.filter(address => !family || address.family === family);
    if (!matching.length) throw Error('extension_cache_dns_mismatch');
    return options?.all ? structuredClone(matching) : { ...matching[0] };
  };
  return () => { globalThis.fetch = originalFetch; dns.lookup = originalLookup; };
}
