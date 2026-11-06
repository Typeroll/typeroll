// The Workers build applies the "browser" file mappings of the AWS SDK and
// Smithy packages (vite/aws-browser-mappings.mjs); a mix of Node and browser
// variants throws in `new S3Client()` and when reading responses on workerd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { awsBrowserMappings } from '../../../vite/aws-browser-mappings.mjs';

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

  it('does not touch application imports of other packages', async () => {
    expect(await resolveWith('/app/src/x.ts')('./x', '/app/src/y.ts')).toBeNull();
  });
});
