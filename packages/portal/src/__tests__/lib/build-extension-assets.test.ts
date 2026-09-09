import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { makeTmpFixtures } from '../helpers/tmp-fixtures';
import { installAssetCache, prepareAssets } from '../../lib/builds/assets.mjs';
import { sha256 } from '../../lib/builds/contract.mjs';
let root: string, restore: undefined | (() => void);
beforeEach(async () => { root = makeTmpFixtures().dir; await fs.mkdir(path.join(root, '.typeroll-runner')); });
afterEach(() => { restore?.(); restore = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('serves only exact verified asset bytes and reuses recorded public DNS offline', async () => {
  const bytes = Buffer.from('export default "verified"'), hash = sha256(bytes);
  await fs.writeFile(path.join(root, '.typeroll-runner/extension-' + hash), bytes);
  await fs.writeFile(path.join(root, '.typeroll-runner/extension-cache.json'), JSON.stringify([{ url: 'https://extension.example.invalid/app.js', hostname: 'extension.example.invalid', sha256: hash, addresses: [{address:'203.0.113.1',family:4}] }]));
  const network = vi.fn(async () => { throw Error('network unavailable'); }); vi.stubGlobal('fetch', network);
  restore = await installAssetCache(root);
  expect(await(await fetch('https://extension.example.invalid/app.js')).text()).toBe(bytes.toString());
  expect(await dns.lookup('extension.example.invalid', {all:true})).toEqual([{address:'203.0.113.1',family:4}]);
  expect(network).not.toHaveBeenCalled();
  await expect(fetch('https://extension.example.invalid/other.js')).rejects.toThrow('network unavailable');
  await expect(fetch('https://extension.example.invalid/app.js', {method:'POST'})).rejects.toThrow('network unavailable');
});
it('rejects altered cached assets before installing the offline adapter', async () => {
  const hash = sha256('expected');
  await fs.writeFile(path.join(root, '.typeroll-runner/extension-' + hash), 'altered');
  await fs.writeFile(path.join(root, '.typeroll-runner/extension-cache.json'), JSON.stringify([{ url:'https://extension.example.invalid/app.js', hostname:'extension.example.invalid', sha256:hash, addresses:[] }]));
  await expect(installAssetCache(root)).rejects.toThrow('integrity');
});

it('prefetches through the frozen extension validator and supports its offline reads', async () => {
  const source = path.resolve('src/lib/extensions');
  const target = path.join(root, 'scripts/source/extensions'); await fs.mkdir(target, {recursive:true});
  for (const name of ['assets.ts', 'public-http.ts']) await fs.copyFile(path.join(source, name), path.join(target, name));
  const script = 'export default 42;', style = '.test{color:green}';
  const snapshot = {installations:[{components:[{id:'example',render_mode:'bundled_component',local_script_url:'/_extensions/app.js',local_style_url:'/_extensions/app.css',entry:{script_url:'https://extension.example.invalid/app.js',script_sha256:sha256(script),style_url:'https://extension.example.invalid/app.css',style_sha256:sha256(style)}}]}]};
  await fs.writeFile(path.join(root, 'publication.json'), JSON.stringify({extensions:snapshot}));
  vi.spyOn(dns, 'lookup').mockResolvedValue([{address:'203.0.113.1',family:4}] as any);
  const network = vi.fn(async (url: any) => new Response(String(url).endsWith('.js') ? script : style)); vi.stubGlobal('fetch', network);
  await prepareAssets(root); expect(network).toHaveBeenCalledTimes(2);
  network.mockRejectedValue(Error('network disabled'));
  restore = await installAssetCache(root);
  const { vendorExtensionAssets } = await import(path.join(root, '.typeroll-runner/extension-preparation.mjs'));
  const result = await vendorExtensionAssets(path.join(root, 'dist'), snapshot);
  expect(result.files).toBe(2); expect(network).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(path.join(root,'dist/_extensions/app.js'),'utf8')).toBe(script);
});
