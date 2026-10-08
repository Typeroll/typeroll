// Runs one release's media step against a shared, file-backed stand-in for R2.
//
//   node publication-upgrade-runner.mjs <release-dir> <store-dir> <work-dir>
//
// <release-dir> holds that release's scripts/fixtures/static-publication/ and
// resolves its own sharp and S3 client, so a previous release runs with the
// encoder it shipped. The grant is created here, from the release's own recipe
// and receipt modules, as that release's portal would. Prints one JSON line.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [releaseDir, storeDir, workDir] = process.argv.slice(2);
const module = name => import(pathToFileURL(path.join(releaseDir, 'scripts/fixtures/static-publication', name)).href);
const { MEDIA_RECIPE_VERSION, MEDIA_VARIANT_SLOTS, mediaVariantSuffix } = await module('media-recipe.mjs');
const { mediaReceiptKey } = await module('media-receipt.mjs');
const media = await module('media.mjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(await fs.readFile(path.join(storeDir, 'fixture.json'), 'utf8'));
const { account, prefix } = fixture, origin = `https://${account}.r2.cloudflarestorage.com`;
const objectFile = key => path.join(storeDir, 'objects', encodeURIComponent(key));
const writes = [];

globalThis.fetch = async (address, options = {}) => {
  const url = new URL(address);
  if (url.origin !== origin) throw Error(`unexpected request to ${url.origin}`);
  const key = decodeURIComponent(url.pathname.slice(1)), file = objectFile(key);
  if (options.method === 'PUT') {
    const body = Buffer.from(options.body instanceof Uint8Array ? options.body : String(options.body));
    try { await fs.writeFile(file, body, { flag: 'wx' }); } catch (error) { if (error.code === 'EEXIST') return new Response(null, { status: 412 }); throw error; }
    writes.push(key);
    return new Response(null);
  }
  try { return new Response(await fs.readFile(file)); } catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
};

const manifest = { delivery: 'static', account_id: account, original_bucket: 'private', public_bucket: 'public', site_prefix: prefix,
  website_host: 'www.example.com', media_host: 'www.example.com', entries: fixture.entries };
const publication = { publication_id: 'f'.repeat(64), media: fixture.entries.map(entry => ({ id: entry.id })), media_manifest: manifest };
const grant = (key) => ({ get: `${origin}/${key}`, put: `${origin}/${key}`, headers: {} });
const objects = {}, prepared = {}, originals = {};
for (const entry of fixture.entries) {
  originals[entry.source_key] = `${origin}/${entry.source_key}`;
  const suffixes = [''];
  if (entry.mime_type.startsWith('image/')) for (const slot of MEDIA_VARIANT_SLOTS) for (const format of ['webp', 'avif']) {
    for (const tail of ['', '.receipt.json']) { const key = `private/${prefix}/prepared/${MEDIA_RECIPE_VERSION}/${entry.sha256}/${slot}.${format}${tail}`; prepared[key] = grant(key); }
    const suffix = mediaVariantSuffix(slot, entry.sha256, format); suffixes.push(suffix, suffix + '.receipt.json');
  }
  for (const base of [entry.public_key, ...entry.aliases.map(alias => alias.key)]) for (const suffix of suffixes) objects[base + suffix] = grant(base + suffix);
  const completion = mediaReceiptKey(manifest, entry); objects[completion] = grant(completion);
}
const grants = Buffer.from(JSON.stringify({ publication_id: publication.publication_id, expires_at: Date.now() + 3600_000, account_id: account, original_bucket: 'private', public_bucket: 'public', originals, objects, prepared }));
const grantKey = `grants/${MEDIA_RECIPE_VERSION}-${process.pid}`;
await fs.writeFile(objectFile(grantKey), grants);
process.env.TYPEROLL_BUILD_MEDIA_ACCESS = JSON.stringify({ grant_url: `${origin}/${grantKey}`, sha256: sha(grants) });

// The order the build engine uses: prepare the library, then materialize this publication's files.
let files;
if (typeof media.prepareMediaBatch === 'function') {
  for (let cursor = 0, total = Infinity; cursor < total;) ({ cursor, total } = await media.prepareMediaBatch(publication, workDir, cursor));
  files = [];
  for (let cursor = 0, total = Infinity; cursor < total;) { const result = await media.prepareMediaBatch(publication, workDir, cursor, { materialize: true, reusableFiles: {} }); files.push(...result.files); ({ cursor, total } = result); }
} else files = await media.prepareMedia(publication, workDir);
const output = {};
for (const file of files) if (file.source) output[file.path] = sha(await fs.readFile(file.source));
console.log(JSON.stringify({ recipe_version: MEDIA_RECIPE_VERSION, writes: writes.filter(key => !key.startsWith('grants/')), files: output }));
