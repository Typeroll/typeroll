import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../../../docs/specs/typeroll-extension-manifest-v3.schema.json', import.meta.url);
const target = new URL('../public/specs/typeroll-extension-manifest-v3.schema.json', import.meta.url);
const expected = await readFile(source);

if (process.argv.includes('--check')) {
  const actual = await readFile(target).catch(() => undefined);
  if (!actual || !actual.equals(expected)) {
    console.error('Public Extension schema is stale. Run npm run sync:extension-schema --workspace=@typeroll/docs-site.');
    process.exitCode = 1;
  } else {
    console.log('Public Extension schema is synchronized');
  }
} else {
  await writeFile(target, expected);
  console.log('Synchronized public Extension schema');
}
