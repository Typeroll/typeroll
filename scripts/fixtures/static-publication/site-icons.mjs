import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_ICON_BYTES = 10 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 20);

// libvips does not decode ICO containers. Support their PNG and uncompressed
// Windows bitmap entries explicitly, bounded by ICO's 256px dimensions.
async function iconInput(bytes) {
  if (bytes.length < 6 || bytes.readUInt32LE(0) !== 0x00010000) return bytes;
  const count = bytes.readUInt16LE(4);
  if (!count || count > 64 || 6 + count * 16 > bytes.length) throw Error('Invalid ICO directory');
  const entries = Array.from({ length: count }, (_, i) => {
    const p = 6 + i * 16;
    return { width: bytes[p] || 256, height: bytes[p + 1] || 256, size: bytes.readUInt32LE(p + 8), offset: bytes.readUInt32LE(p + 12) };
  }).sort((a, b) => b.width * b.height - a.width * a.height);
  for (const entry of entries) {
    const { width, height, offset, size } = entry;
    if (!size || offset < 6 + count * 16 || offset + size > bytes.length) throw Error('Invalid ICO entry');
    const image = bytes.subarray(offset, offset + size);
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return image;
    if (image.length < 40) continue;
    const header = image.readUInt32LE(0), bits = image.readUInt16LE(14);
    if (header < 40 || header > image.length || image.readInt32LE(4) !== width || Math.abs(image.readInt32LE(8)) !== height * 2 || image.readUInt32LE(16) !== 0 || ![1, 4, 8, 24, 32].includes(bits)) continue;
    const colors = bits <= 8 ? image.readUInt32LE(32) || 2 ** bits : 0;
    if (colors > 2 ** bits) throw Error('Invalid ICO palette');
    const pixels = header + colors * 4, stride = Math.ceil(width * bits / 32) * 4;
    const mask = pixels + stride * height, maskStride = Math.ceil(width / 32) * 4;
    if (mask > image.length) throw Error('Truncated ICO bitmap');
    const rgba = Buffer.alloc(width * height * 4);
    let hasAlpha = false;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const row = image.readInt32LE(8) < 0 ? y : height - 1 - y;
      let p = pixels + row * stride + Math.floor(x * bits / 8);
      if (bits <= 8) {
        const index = (image[p] >> (8 - bits - x * bits % 8)) & (2 ** bits - 1);
        if (index >= colors) throw Error('Invalid ICO palette index');
        p = header + index * 4;
      }
      const target = (y * width + x) * 4;
      rgba[target] = image[p + 2]; rgba[target + 1] = image[p + 1]; rgba[target + 2] = image[p];
      rgba[target + 3] = bits === 32 ? image[p + 3] : 255;
      if (bits === 32 && image[p + 3]) hasAlpha = true;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4 + 3;
      if (bits === 32 && !hasAlpha) rgba[target] = 255;
      const row = image.readInt32LE(8) < 0 ? y : height - 1 - y;
      if (mask + maskStride * height <= image.length && (image[mask + row * maskStride + (x >> 3)] & (128 >> (x % 8)))) rgba[target] = 0;
    }
    return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }
  throw Error('Unsupported ICO image');
}

// PNG-backed ICO entries are supported by modern browsers and preserve alpha.
export function packIcon(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, bytes }, index) => {
    const start = 6 + index * 16;
    directory[start] = size; directory[start + 1] = size;
    directory.writeUInt16LE(1, start + 4); directory.writeUInt16LE(32, start + 6);
    directory.writeUInt32LE(bytes.length, start + 8); directory.writeUInt32LE(offset, start + 12);
    offset += bytes.length;
  });
  return Buffer.concat([directory, ...images.map(image => image.bytes)]);
}

async function renderIcon(bytes, size) {
  return sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'error' }).rotate()
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

/** No network or credential access. Callers supply bounded, verified public image bytes. */
export async function writeSiteIcons(dist, settings, readImage) {
  const fallback = await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const loaded = new Map();
  async function load(field) {
    const url = settings[field];
    if (!url) return null;
    if (!loaded.has(url)) {
      const bytes = Buffer.from(await readImage(url));
      if (!bytes.length || bytes.length > MAX_ICON_BYTES) throw Error(`${field}: icon exceeds the supported size`);
      loaded.set(url, await iconInput(bytes));
    }
    return loaded.get(url);
  }
  let favicon, icon192;
  try {
    const source = await load('favicon') ?? await load('icon_192') ?? fallback;
    favicon = packIcon(await Promise.all([16, 32, 48].map(async size => ({ size, bytes: await renderIcon(source, size) }))));
    icon192 = await renderIcon(await load('icon_192') ?? source, 192);
  } catch (error) {
    // Do not reflect URLs, signed query strings or decoder content in public errors.
    throw new Error('site_icon_build_failed: check favicon and icon_192 image settings', { cause: error });
  }
  const faviconUrl = `/_assets/icons/favicon-${digest(favicon)}.ico`;
  const iconUrl = `/_assets/icons/icon-192-${digest(icon192)}.png`;
  await fs.mkdir(path.join(dist, '_assets/icons'), { recursive: true });
  await fs.writeFile(path.join(dist, faviconUrl), favicon);
  await fs.writeFile(path.join(dist, iconUrl), icon192);
  await fs.writeFile(path.join(dist, 'favicon.ico'), favicon);
  await fs.writeFile(path.join(dist, 'site.webmanifest'), JSON.stringify({
    name: settings.site_name ?? '', icons: [{ src: iconUrl, sizes: '192x192', type: 'image/png' }],
  }));
  async function rewrite(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await rewrite(file);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const html = await fs.readFile(file, 'utf8');
        const next = html.replace(/<link\b[^>]*data-site-icon="(?:favicon|icon_192|manifest)"[^>]*>/g, '')
          .replace(/<link\b[^>]*\brel\s*=\s*["']manifest["'][^>]*>/gi, '')
          .replace('</head>', `<link data-site-icon="favicon" rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="${faviconUrl}"><link data-site-icon="icon_192" rel="icon" type="image/png" sizes="192x192" href="${iconUrl}"><link data-site-icon="manifest" rel="manifest" href="/site.webmanifest"></head>`);
        if (next !== html) await fs.writeFile(file, next);
      }
    }
  }
  await rewrite(dist);
  return { favicon_url: faviconUrl, icon_192_url: iconUrl };
}

/** Resolve only records in the frozen media manifest, never arbitrary URLs or paths. */
export async function readFrozenIcon(publication, files, url) {
  const entry = publication.media_manifest?.entries.find(entry => matchesIcon(publication, entry, url));
  const file = entry && files.find(file => file.path === entry.public_path && !file.reused);
  if (!file?.source) throw Error('Configured site icon is not available in verified publication media');
  return fs.readFile(file.source);
}

export function isSiteIconEntry(publication, entry) {
  return [publication.settings?.favicon, publication.settings?.icon_192].filter(Boolean).some(url => matchesIcon(publication, entry, url));
}

function matchesIcon(publication, entry, raw) {
  const url = publication.reference_mapping?.media?.find(([from]) => from === raw)?.[1] ?? raw;
  return (
    entry.cdn_url === url || entry.public_path === url || entry.aliases?.some(alias => alias.url === url)
    || (publication.site_url && new URL(entry.public_path, publication.site_url).href === url));
}
