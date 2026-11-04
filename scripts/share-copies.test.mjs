import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { prepareMedia, prepareMediaBatch } from './fixtures/static-publication/media.mjs';
import { mediaReceiptKey } from './fixtures/static-publication/media-receipt.mjs';
import { MEDIA_RECIPE_VERSION, MEDIA_VARIANT_SLOTS, mediaVariantSuffix, shareCopyTarget } from './fixtures/static-publication/media-recipe.mjs';
import { writeShareImages } from './fixtures/static-publication/share-images.mjs';

// Share copies of images on a separate media host go through the ordinary
// media stage: exact R2 grants, immutable keys, receipts and reuse.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const account = 'a'.repeat(32), prefix = 'media/abcdefghij', origin = `https://${account}.r2.cloudflarestorage.com`;
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40" viewBox="0 0 200 40"><rect width="200" height="40" fill="#c60075"/></svg>');

async function withShareFixture(run, { grantShare = true, rejectPut = () => false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'share-copies-'));
  const fetchBefore = globalThis.fetch, envBefore = process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#3366aa' } }).png().toBuffer();
  const stored = new Map(), writes = [], objects = {}, prepared = {}, originals = {};
  const entries = [
    { id: 'logo', mime_type: 'image/svg+xml', bytes: svg, name: 'logo.svg' },
    { id: 'photo', mime_type: 'image/png', bytes: photo, name: 'photo.png' },
  ].map(({ id, mime_type, bytes, name }) => {
    const sourceKey = `private/${prefix}/originals/${name}`;
    stored.set(sourceKey, bytes); originals[sourceKey] = `${origin}/${sourceKey}`;
    return { id, mime_type, source_key: sourceKey, public_key: `${prefix}/${name}`, public_path: `/${name}`, cdn_url: `https://media.site.test/${name}`,
      sha256: sha(bytes), size_bytes: bytes.length, aliases: [{ url: `https://media.shared.test/${prefix}/${name}`, key: `${prefix}/${name}` }], share_source: true };
  });
  const manifest = { delivery: 'r2', account_id: account, original_bucket: 'private', public_bucket: 'public', site_prefix: prefix,
    website_host: 'www.site.test', media_host: 'media.site.test', share_background: '#102030', entries };
  const grant = key => ({ get: `${origin}/${key}`, put: `${origin}/${key}`, headers: {} });
  for (const entry of entries) {
    objects[entry.public_key] = grant(entry.public_key);
    objects[mediaReceiptKey(manifest, entry)] = grant(mediaReceiptKey(manifest, entry));
    if (entry.mime_type === 'image/png') for (const slot of MEDIA_VARIANT_SLOTS) for (const format of ['webp', 'avif']) {
      const suffix = mediaVariantSuffix(slot, entry.sha256, format);
      objects[entry.public_key + suffix] = grant(entry.public_key + suffix);
      objects[entry.public_key + suffix + '.receipt.json'] = grant(entry.public_key + suffix + '.receipt.json');
      for (const tail of ['', '.receipt.json']) { const key = `private/${prefix}/prepared/${MEDIA_RECIPE_VERSION}/${entry.sha256}/${slot}.${format}${tail}`; prepared[key] = grant(key); }
    }
    const share = shareCopyTarget(manifest, entry);
    if (grantShare) { objects[share.key] = grant(share.key); objects[share.receipt_key] = grant(share.receipt_key); }
  }
  const grants = Buffer.from(JSON.stringify({ publication_id: 'frozen', expires_at: Date.now() + 60_000, account_id: account, original_bucket: 'private', public_bucket: 'public', originals, objects, prepared }));
  process.env.TYPEROLL_BUILD_MEDIA_ACCESS = JSON.stringify({ grant_url: `${origin}/grant`, sha256: sha(grants) });
  globalThis.fetch = async (address, options = {}) => {
    const key = new URL(address).pathname.slice(1);
    if (key === 'grant') return new Response(grants);
    if (options.method === 'PUT') {
      if (rejectPut(key)) return new Response(null, { status: 403 });
      if (stored.has(key)) return new Response(null, { status: 412 });
      stored.set(key, Buffer.from(options.body)); writes.push(key); return new Response(null);
    }
    return stored.has(key) ? new Response(stored.get(key)) : new Response(null, { status: 404 });
  };
  const publication = () => ({ publication_id: 'frozen', site_url: 'https://www.site.test', settings: { colors: { background: '#123' } }, contentTypes: [], pages: [],
    media: entries.map(entry => ({ id: entry.id, cdn_url: entry.cdn_url, mime_type: entry.mime_type, size_bytes: entry.size_bytes })), media_manifest: manifest });
  try { await run({ publication, manifest, entries, stored, writes, root }); }
  finally {
    globalThis.fetch = fetchBefore;
    if (envBefore === undefined) delete process.env.TYPEROLL_BUILD_MEDIA_ACCESS; else process.env.TYPEROLL_BUILD_MEDIA_ACCESS = envBefore;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('the media stage stores share copies on the media host with receipts, and reuses them unchanged', () => withShareFixture(async ({ publication, manifest, entries, stored, writes, root }) => {
  const first = publication();
  const files = await prepareMedia(first, root);
  const [logo, photo] = entries.map(entry => shareCopyTarget(manifest, entry));
  assert.equal(logo.url, `https://media.site.test/logo.svg.share-s1.card.${entries[0].sha256.slice(0, 16)}.102030.png`);
  assert.match(photo.url, /^https:\/\/media\.site\.test\/photo\.png\.share-s1\.photo\.[a-f0-9]{16}\.jpg$/);
  const card = stored.get(logo.key), jpeg = stored.get(photo.key);
  assert.deepEqual([(await sharp(card).metadata()).width, (await sharp(card).metadata()).height], [1200, 630]);
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg');
  assert.equal((await sharp(jpeg).metadata()).width, 1200);
  assert.ok(jpeg.length < 300_000);
  assert.deepEqual(JSON.parse(stored.get(logo.receipt_key)), { format: 1, recipe: 's1', kind: 'card', source_sha256: entries[0].sha256, mime_type: 'image/png', sha256: sha(card), size_bytes: card.length, width: 1200, height: 630 });
  assert.deepEqual(first.media.find(item => item.id === 'logo').share_copy, { kind: 'card', url: logo.url, mime_type: 'image/png', width: 1200, height: 630, sha256: sha(card), size_bytes: card.length });
  assert.equal(first.media.find(item => item.id === 'photo').share_copy.mime_type, 'image/jpeg');
  // Nothing about the copy is published on the website.
  assert.ok(!files.some(file => !file.local_only && /share/.test(file.path)));
  // An unchanged image reuses its copy: no write, same reference.
  writes.length = 0;
  const second = publication();
  await prepareMedia(second, root);
  assert.deepEqual(writes.filter(key => key.includes('.share-')), []);
  assert.deepEqual(second.media.find(item => item.id === 'logo').share_copy, first.media.find(item => item.id === 'logo').share_copy);
}));

test('a batched build stores copies while preparing and reads them back while materializing', () => withShareFixture(async ({ publication, manifest, entries, stored, root }) => {
  const preparing = publication();
  let cursor = 0;
  while (cursor < entries.length) cursor = (await prepareMediaBatch(preparing, root, cursor, { maxEntries: 1 })).cursor;
  assert.ok(stored.has(shareCopyTarget(manifest, entries[0]).key));
  const materializing = publication();
  const result = await prepareMediaBatch(materializing, root, 0, { materialize: true });
  assert.equal(result.media.find(item => item.id === 'logo').share_copy.url, shareCopyTarget(manifest, entries[0]).url);
}));

test('a copy stored before an interrupted receipt is described, never rendered again', () => withShareFixture(async ({ publication, manifest, entries, stored, root }) => {
  const target = shareCopyTarget(manifest, entries[0]);
  const earlier = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#000000' } }).png().toBuffer();
  stored.set(target.key, earlier);
  const pub = publication();
  await prepareMedia(pub, root);
  assert.equal(JSON.parse(stored.get(target.receipt_key)).sha256, sha(earlier));
  assert.equal(pub.media.find(item => item.id === 'logo').share_copy.sha256, sha(earlier));
}));

test('a failed copy upload stops the build so the previous publication stays live', () => withShareFixture(async ({ publication, root }) => {
  await assert.rejects(prepareMedia(publication(), root), /Media storage rejected access/);
}, { rejectPut: key => key.includes('.share-') }));

test('without exact grants for a copy the page keeps its website copy', () => withShareFixture(async ({ publication, root }) => {
  const pub = publication();
  await prepareMedia(pub, root);
  assert.ok(pub.media.every(item => !item.share_copy));
}, { grantShare: false }));

test('pages reference the media-host copy with consistent tags; the earlier website address redirects to it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-render-'));
  try {
    const copy = { kind: 'card', url: 'https://media.site.test/logo.svg.share-s1.card.0123456789abcdef.102030.png', mime_type: 'image/png', width: 1200, height: 630, sha256: 'e'.repeat(64), size_bytes: 1000 };
    const photo = { kind: 'photo', url: 'https://media.site.test/photo.png.share-s1.photo.0123456789abcdef.jpg', mime_type: 'image/jpeg', width: 1200, height: 800, sha256: 'f'.repeat(64), size_bytes: 2000 };
    const entries = [{ id: 'logo', mime_type: 'image/svg+xml', cdn_url: 'https://media.site.test/logo.svg', public_path: '/logo.svg', aliases: [], share_source: true },
      { id: 'photo', mime_type: 'image/png', cdn_url: 'https://media.site.test/photo.png', public_path: '/photo.png', aliases: [], share_source: true }];
    const pub = { site_url: 'https://www.site.test', settings: {}, contentTypes: [], pages: [], media_manifest: { delivery: 'r2', media_host: 'media.site.test', website_host: 'www.site.test', entries },
      media: [{ id: 'logo', cdn_url: entries[0].cdn_url, mime_type: 'image/svg+xml', share_copy: copy },
        { id: 'photo', cdn_url: entries[1].cdn_url, mime_type: 'image/png', size_bytes: 4_000_000, width: 2400, share_copy: photo, variants: [] }] };
    const page = image => `<html><head><meta property="og:image" content="${image}"><meta property="og:image:type" content="image/svg+xml"><meta name="twitter:image" content="${image}"></head></html>`;
    await fs.writeFile(path.join(dir, 'index.html'), page(entries[0].cdn_url));
    await fs.mkdir(path.join(dir, 'p'));
    await fs.writeFile(path.join(dir, 'p/index.html'), page(entries[1].cdn_url));
    await fs.writeFile(path.join(dir, '_redirects'), '/old /new 301');
    const result = await writeShareImages(dir, pub, async () => { throw new Error('no local render'); }, async () => { throw new Error('no local render'); });
    assert.deepEqual(result, { pages: 2, images: 2 });
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes(`<meta property="og:image" content="${copy.url}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`));
    assert.ok(html.includes(`<meta name="twitter:image" content="${copy.url}">`));
    const other = await fs.readFile(path.join(dir, 'p/index.html'), 'utf8');
    assert.match(other, /og:image:type" content="image\/jpeg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800"/);
    await assert.rejects(fs.access(path.join(dir, '_assets')));
    assert.equal(await fs.readFile(path.join(dir, '_redirects'), 'utf8'),
      `/old /new 301\n/_assets/share/share-${'e'.repeat(20)}.png ${copy.url} 301\n/_assets/share/share-${'f'.repeat(20)}.jpg ${photo.url} 301\n`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('with the redirect budget spent, a page keeps the website copy so earlier addresses still answer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-budget-'));
  try {
    const entries = [{ id: 'logo', mime_type: 'image/svg+xml', cdn_url: 'https://media.site.test/logo.svg', public_path: '/logo.svg', aliases: [], share_source: true }];
    const pub = { site_url: 'https://www.site.test', settings: {}, contentTypes: [], pages: [], media_manifest: { delivery: 'r2', media_host: 'media.site.test', website_host: 'www.site.test', entries },
      media: [{ id: 'logo', cdn_url: entries[0].cdn_url, mime_type: 'image/svg+xml', share_copy: { kind: 'card', url: 'https://media.site.test/x.png', mime_type: 'image/png', width: 1200, height: 630, sha256: 'e'.repeat(64), size_bytes: 1 } }] };
    await fs.writeFile(path.join(dir, 'index.html'), `<html><head><meta property="og:image" content="${entries[0].cdn_url}"><meta name="twitter:image" content="${entries[0].cdn_url}"></head></html>`);
    const full = Array.from({ length: 2000 }, (_, index) => `/r${index} /t 301`).join('\n');
    await fs.writeFile(path.join(dir, '_redirects'), full);
    await writeShareImages(dir, pub, async () => svg);
    assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /og:image" content="https:\/\/www\.site\.test\/_assets\/share\/share-[a-f0-9]{20}\.png"/);
    assert.equal(await fs.readFile(path.join(dir, '_redirects'), 'utf8'), full);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('without a separate media host the existing website delivery is kept', () => {
  const entry = { id: 'logo', mime_type: 'image/svg+xml', cdn_url: 'https://www.site.test/media/logo.svg', public_key: `${prefix}/media/logo.svg`, sha256: 'a'.repeat(64), share_source: true };
  assert.equal(shareCopyTarget({ delivery: 'static', media_host: 'www.site.test', website_host: 'www.site.test' }, entry), null);
  assert.ok(shareCopyTarget({ delivery: 'r2', media_host: 'media.shared.test', website_host: 'www.site.test' }, entry));
  assert.equal(shareCopyTarget({ delivery: 'r2', media_host: 'media.shared.test', website_host: 'www.site.test' }, { ...entry, share_source: undefined }), null);
});
