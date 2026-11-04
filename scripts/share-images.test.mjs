import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { isShareImageEntry, needsShareDerivative, readFrozenShareImage, renderShareDerivative, renderShareImage, shareDerivativeSource, shareImageSources, shareVariantWidth, writeShareImages, SHARE_WIDTH, SHARE_HEIGHT } from './fixtures/static-publication/share-images.mjs';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40" viewBox="0 0 200 40"><rect width="200" height="40" fill="#c60075"/></svg>');
const entry = { id: 'logo', mime_type: 'image/svg+xml', cdn_url: 'https://media.example/s/logo.svg', public_path: '/s/logo.svg', aliases: [] };
const png = { id: 'photo', mime_type: 'image/png', cdn_url: 'https://media.example/s/photo.png', public_path: '/s/photo.png', aliases: [] };
const publication = (settings = {}, pages = []) => ({
  site_url: 'https://site.example', settings, pages, contentTypes: [], media_manifest: { entries: [entry, png] },
});
const page = (image, alt = '') => `<html><head><meta property="og:image" content="${image}"><meta property="og:image:type" content="image/svg+xml">${alt}<meta name="twitter:image" content="${image}"></head><body></body></html>`;

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-images-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('share sources cover the site default, the logo fallback, page images and mapped image fields', () => {
  const sources = shareImageSources({
    settings: { default_og_image: ' /a.svg ', logo: '/logo.svg' },
    contentTypes: [{ id: 'post', schema_field_map: { cover: 'image', title: 'headline' } }],
    pages: [{ og_image: '/b.svg' }, { content_type: 'post', fields: { cover: '/c.svg', title: '/not-an-image' } }],
  });
  assert.deepEqual([...sources].sort(), ['/a.svg', '/b.svg', '/c.svg', '/logo.svg']);
});

test('only non-raster media that some page can share is prepared for a copy', () => {
  const pub = publication({ logo: entry.cdn_url, default_og_image: png.cdn_url });
  assert.equal(isShareImageEntry(pub, entry), true);
  assert.equal(isShareImageEntry(pub, png), false);
  assert.equal(isShareImageEntry(publication({}), entry), false);
});

test('the copy is a 1200×630 PNG on the site background with the logo contained', async () => {
  const bytes = await renderShareImage(svg, '#0000ff');
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, SHARE_WIDTH);
  assert.equal(info.height, SHARE_HEIGHT);
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual(pixel(5, 5), [0, 0, 255]);
  assert.deepEqual(pixel(600, 315), [198, 0, 117]);
  assert.deepEqual(await renderShareImage(svg, '#0000ff'), bytes, 'deterministic');
});

test('pages sharing an SVG get the PNG in og:image and twitter:image; other pages are untouched', () => fixture(async dir => {
  await fs.writeFile(path.join(dir, 'index.html'), page(entry.cdn_url));
  await fs.mkdir(path.join(dir, 'about'));
  await fs.writeFile(path.join(dir, 'about/index.html'), page(png.cdn_url));
  const pub = publication({ logo: entry.cdn_url, colors: { background: '#fbfaf6' } });
  const reads = [];
  const result = await writeShareImages(dir, pub, async url => { reads.push(url); return svg; });
  assert.deepEqual(reads, [entry.cdn_url]);
  assert.deepEqual(result, { pages: 1, images: 1 });
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  const url = html.match(/property="og:image" content="([^"]+)"/)[1];
  assert.match(url, /^https:\/\/site\.example\/_assets\/share\/share-[a-f0-9]{20}\.png$/);
  assert.ok(html.includes(`<meta name="twitter:image" content="${url}">`));
  assert.ok(html.includes('<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'));
  assert.ok(!html.includes('image/svg+xml'));
  const written = await fs.readFile(path.join(dir, new URL(url).pathname));
  assert.equal((await sharp(written).metadata()).width, 1200);
  assert.equal(await fs.readFile(path.join(dir, 'about/index.html'), 'utf8'), page(png.cdn_url));
}));

test('an unreadable or invalid source leaves the page as it was', () => fixture(async dir => {
  await fs.writeFile(path.join(dir, 'index.html'), page(entry.cdn_url));
  const pub = publication({ logo: entry.cdn_url });
  assert.deepEqual(await writeShareImages(dir, pub, async () => null), { pages: 0, images: 0 });
  assert.deepEqual(await writeShareImages(dir, pub, async () => Buffer.from('<html>no</html>')), { pages: 0, images: 0 });
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), page(entry.cdn_url));
}));

test('frozen share images only read verified, locally prepared manifest media', () => fixture(async dir => {
  const file = path.join(dir, 'logo.svg');
  await fs.writeFile(file, svg);
  const pub = publication({ logo: entry.cdn_url });
  const files = [{ path: entry.public_path, source: file, local_only: true }];
  assert.deepEqual(await readFrozenShareImage(pub, files, entry.cdn_url), svg);
  assert.equal(await readFrozenShareImage(pub, files, 'https://evil.example/s/logo.svg'), null);
  assert.equal(await readFrozenShareImage(pub, [{ ...files[0], reused: true }], entry.cdn_url), null);
}));

test('a large raster share image is copied from its 1920 WebP variant as a ~1200 px JPEG; small ones stay', () => fixture(async dir => {
  const webp = await sharp({ create: { width: 1920, height: 1280, channels: 3, background: '#3366aa' } }).webp().toBuffer();
  const sha = createHash('sha256').update(webp).digest('hex');
  const large = { id: 'large', mime_type: 'image/png', cdn_url: 'https://media.example/s/large.png', size_bytes: 4_000_000, width: 2048,
    variants: [{ width: 1024, format: 'webp', sha256: 'a'.repeat(64), cdn_url: 'https://media.example/s/large.png.w1024.webp' },
      { width: 1920, format: 'webp', sha256: sha, cdn_url: 'https://media.example/s/large.png.w1920.webp' }] };
  const small = { id: 'small', mime_type: 'image/jpeg', cdn_url: 'https://media.example/s/share.jpg', size_bytes: 90_000, width: 1200, variants: [] };
  const pub = { site_url: 'https://site.example', settings: {}, contentTypes: [], media: [large, small],
    pages: [{ og_image: large.cdn_url }, { og_image: small.cdn_url }], media_manifest: { entries: [] } };
  assert.equal(shareVariantWidth([320, 640, 1024, 1920]), 1920);
  assert.equal(shareVariantWidth([320, 640, 1024]), 1024);
  assert.equal(needsShareDerivative(pub, { ...large, aliases: [] }, 2048), true);
  assert.equal(needsShareDerivative(pub, { ...small, aliases: [] }, 1200), false);
  assert.deepEqual(shareDerivativeSource(pub, large.cdn_url), { url: large.variants[1].cdn_url, sha256: sha, size_bytes: undefined });
  assert.equal(shareDerivativeSource(pub, small.cdn_url), null);
  const copy = await renderShareDerivative(webp);
  assert.deepEqual([copy.width, copy.height], [1200, 800]);
  assert.ok(copy.bytes.length < 300_000);
  await fs.writeFile(path.join(dir, 'index.html'), page(large.cdn_url));
  await fs.mkdir(path.join(dir, 'small'));
  await fs.writeFile(path.join(dir, 'small/index.html'), page(small.cdn_url));
  const reads = [];
  const result = await writeShareImages(dir, pub, async () => null, async source => { reads.push(source.url); return webp; });
  assert.deepEqual(reads, [large.variants[1].cdn_url]);
  assert.deepEqual(result, { pages: 1, images: 1 });
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /property="og:image" content="https:\/\/site\.example\/_assets\/share\/share-[a-f0-9]{20}\.jpg"/);
  assert.match(html, /og:image:type" content="image\/jpeg"/);
  assert.match(html, /og:image:width" content="1200"/);
  assert.match(html, /og:image:height" content="800"/);
  assert.match(html, /name="twitter:image" content="https:\/\/site\.example\/_assets\/share\//);
  assert.equal(await fs.readFile(path.join(dir, 'small/index.html'), 'utf8'), page(small.cdn_url));
  // Bytes that do not match the variant's hash are never used.
  await fs.writeFile(path.join(dir, 'index.html'), page(large.cdn_url));
  assert.deepEqual(await writeShareImages(dir, pub, async () => null, async () => Buffer.from('tampered')), { pages: 0, images: 0 });
}));

test('the media stage recognises share images from the portal flag without any pages', () => {
  const bare = { site_url: 'https://site.example', settings: {}, contentTypes: [], pages: [], media_manifest: { entries: [] } };
  assert.equal(needsShareDerivative(bare, { id: 'p', mime_type: 'image/png', size_bytes: 4_000_000, cdn_url: 'https://media.example/s/p.png', aliases: [], share_source: true }, 2048), true);
  assert.equal(needsShareDerivative(bare, { id: 'p', mime_type: 'image/png', size_bytes: 4_000_000, cdn_url: 'https://media.example/s/p.png', aliases: [] }, 2048), false);
  assert.equal(isShareImageEntry(bare, { ...entry, share_source: true }), true);
});

