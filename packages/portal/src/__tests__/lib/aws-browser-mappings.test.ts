// The Workers build applies the "browser" file mappings of the AWS SDK and
// Smithy packages (vite/aws-browser-mappings.mjs); a mix of Node and browser
// variants throws in `new S3Client()` and when reading responses on workerd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { awsBrowserMappings, KEEP_NODE_FILE } from '../../../vite/aws-browser-mappings.mjs';

function fixture(name: string, browser: Record<string, string> | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-mappings-'));
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(dir, 'dist-es'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...(browser ? { browser } : {}) }));
  for (const file of ['runtimeConfig.js', 'runtimeConfig.browser.js', 'S3Client.js']) fs.writeFileSync(path.join(dir, 'dist-es', file), '');
  return dir;
}

const resolveWith = (resolved: string | null) => async (source: string, importer: string) =>
  (awsBrowserMappings.resolveId as Function).call({ resolve: async () => (resolved ? { id: resolved } : null) }, source, importer, {});

describe('awsBrowserMappings', () => {
  it('replaces a mapped Node file of an AWS SDK package with its browser file', async () => {
    const dir = fixture('@aws-sdk/client-example', { './dist-es/runtimeConfig': './dist-es/runtimeConfig.browser' });
    const result = await resolveWith(path.join(dir, 'dist-es', 'runtimeConfig.js'))('./runtimeConfig', path.join(dir, 'dist-es', 'S3Client.js'));
    expect(result.id).toBe(path.join(dir, 'dist-es', 'runtimeConfig.browser.js'));
  });

  it('leaves other packages and unmapped files alone', async () => {
    const other = fixture('left-pad', { './dist-es/runtimeConfig': './dist-es/runtimeConfig.browser' });
    const file = path.join(other, 'dist-es', 'runtimeConfig.js');
    expect((await resolveWith(file)('./runtimeConfig', path.join(other, 'dist-es', 'S3Client.js'))).id).toBe(file);
    const aws = fixture('@smithy/example', undefined);
    const plain = path.join(aws, 'dist-es', 'S3Client.js');
    expect((await resolveWith(plain)('./S3Client', path.join(aws, 'dist-es', 'runtimeConfig.js'))).id).toBe(plain);
  });

  it('keeps the XML parser that runs on workerd instead of the DOMParser one', async () => {
    const dir = fixture('@aws-sdk/xml-builder', { './dist-es/xml-parser': './dist-es/xml-parser.browser' });
    fs.writeFileSync(path.join(dir, 'dist-es', 'xml-parser.js'), '');
    fs.writeFileSync(path.join(dir, 'dist-es', 'xml-parser.browser.js'), '');
    const file = path.join(dir, 'dist-es', 'xml-parser.js');
    expect((await resolveWith(file)('./xml-parser', path.join(dir, 'dist-es', 'S3Client.js'))).id).toBe(file);
  });

  it('applies no browser file that needs a global workerd lacks', () => {
    const root = path.resolve(__dirname, '../../../../../node_modules');
    const found: string[] = [];
    for (const scope of ['@aws-sdk', '@smithy', '@aws-crypto']) {
      if (!fs.existsSync(path.join(root, scope))) continue;
      for (const name of fs.readdirSync(path.join(root, scope))) {
        const dir = path.join(root, scope, name), manifest = path.join(dir, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        const browser = JSON.parse(fs.readFileSync(manifest, 'utf8')).browser;
        if (!browser || typeof browser !== 'object') continue;
        for (const [key, target] of Object.entries(browser)) {
          if (typeof target !== 'string' || KEEP_NODE_FILE.has(`${scope}/${name}:${key}`)) continue;
          const file = [path.resolve(dir, target), `${path.resolve(dir, target)}.js`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
          if (file && /\b(DOMParser|XMLHttpRequest|localStorage)\b/.test(fs.readFileSync(file, 'utf8'))) found.push(`${scope}/${name} ${key}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('does not touch application imports of other packages', async () => {
    expect(await resolveWith('/app/src/x.ts')('./x', '/app/src/y.ts')).toBeNull();
  });
});
