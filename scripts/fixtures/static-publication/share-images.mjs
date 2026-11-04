import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Facebook, LinkedIn, X and Slack do not show SVG (or AVIF/TIFF) share images.
// When a page's og:image is such a file from the site's verified publication
// media, the build renders a 1200×630 PNG copy, letterboxed on the site
// background so a logo is never cropped, and points og:image and
// twitter:image at it. Everything here runs offline on verified bytes and
// travels with the frozen publication, so no build engine update is needed.

export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 630;
// The image sits inside this box, leaving a margin on the card.
const INNER_WIDTH = 1040;
const INNER_HEIGHT = 470;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SHARE_IMAGES = 20;
const RASTERIZE = new Set(['image/svg+xml', 'image/avif', 'image/tiff']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 20);
const essence = type => String(type ?? '').split(';')[0].trim().toLowerCase();
const text = value => typeof value === 'string' ? value.trim() : '';

const sourceCache = new WeakMap();
/** Every URL a page or the site can select as its share image. */
export function shareImageSources(publication) {
  if (sourceCache.has(publication)) return sourceCache.get(publication);
  const sources = new Set();
  const add = value => { if (text(value)) sources.add(text(value)); };
  add(publication.settings?.default_og_image);
  add(publication.settings?.logo);
  const mapped = new Map();
  for (const type of publication.contentTypes ?? []) {
    const fields = Object.entries(type.schema_field_map ?? {}).filter(([, property]) => property === 'image').map(([field]) => field);
    if (fields.length) mapped.set(type.id, fields);
  }
  for (const page of publication.pages ?? []) {
    add(page.og_image);
    for (const field of mapped.get(page.content_type ?? 'page') ?? []) add(page.fields?.[field]);
  }
  sourceCache.set(publication, sources);
  return sources;
}

function matchesEntry(publication, entry, raw) {
  const url = publication.reference_mapping?.media?.find(([from]) => from === raw)?.[1] ?? raw;
  if (entry.cdn_url === url || entry.public_path === url || entry.aliases?.some(alias => alias.url === url)) return true;
  try { return Boolean(publication.site_url) && new URL(entry.public_path, publication.site_url).href === url; }
  catch { return false; }
}

/** A manifest entry that some page may share and that networks cannot show as it is. */
export function isShareImageEntry(publication, entry) {
  if (!RASTERIZE.has(essence(entry.mime_type))) return false;
  // The portal marks share images; the build's media stage has no pages to find them.
  if (entry.share_source === true) return true;
  for (const source of shareImageSources(publication)) if (matchesEntry(publication, entry, source)) return true;
  return false;
}

/** Resolve only verified, locally prepared publication media, never arbitrary URLs or paths. */
export async function readFrozenShareImage(publication, files, url) {
  const entry = publication.media_manifest?.entries.find(candidate => isShareImageEntry(publication, candidate) && matchesEntry(publication, candidate, url));
  if (!entry) return null;
  const file = files.find(candidate => candidate.path === entry.public_path && !candidate.reused && candidate.source);
  if (!file) return null;
  const bytes = await fs.readFile(file.source);
  return bytes.length > MAX_SOURCE_BYTES ? null : bytes;
}

function backgroundColor(settings) {
  const value = text(settings?.colors?.background);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : '#ffffff';
}

/** A 1200×630 PNG with the image contained (never cropped) on the background colour. */
export async function renderShareImage(bytes, background = '#ffffff') {
  const options = { limitInputPixels: 40_000_000, failOn: 'error' };
  const metadata = await sharp(bytes, options).metadata();
  // Rasterize vectors at the density that fills the box instead of upscaling a small bitmap.
  const density = metadata.format === 'svg' && metadata.width && metadata.height
    ? Math.min(2400, Math.max(1, 72 * Math.min(INNER_WIDTH / metadata.width, INNER_HEIGHT / metadata.height)))
    : undefined;
  const inner = await sharp(bytes, { ...options, ...(density ? { density } : {}) }).rotate()
    .resize(INNER_WIDTH, INNER_HEIGHT, { fit: 'inside' }).png().toBuffer();
  return sharp({ create: { width: SHARE_WIDTH, height: SHARE_HEIGHT, channels: 4, background } })
    .composite([{ input: inner, gravity: 'centre' }])
    .flatten({ background })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Large raster share images (SE-10): a 2048 px PNG makes a 4 MB og:image.
// Pages that share one get a JPEG copy about 1200 px wide, made from the
// image's own prepared WebP variant (never the original, never upscaled), so
// the srcset keeps every large variant for sharp on-page display.
const RASTER_SHARE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SHARE_MAX_BYTES = 300_000;
const MAX_DERIVATIVES = 2_000;

/** True when some page or the site may share this entry and it is a raster image too large to share as it is. */
export function needsShareDerivative(publication, entry, width, sizeBytes = entry.size_bytes) {
  if (!RASTER_SHARE.has(essence(entry.mime_type)) || !(Number(sizeBytes) > SHARE_MAX_BYTES || Number(width) > SHARE_WIDTH)) return false;
  if (entry.share_source === true) return true;
  for (const source of shareImageSources(publication)) if (matchesEntry(publication, entry, source)) return true;
  return false;
}

/** Of the prepared variant widths, the one a share copy is made from: the smallest at least 1200 px, else the largest. */
export function shareVariantWidth(widths) {
  const sorted = [...widths].filter(Number.isSafeInteger).sort((a, b) => a - b);
  return sorted.find(width => width >= SHARE_WIDTH) ?? sorted.at(-1) ?? null;
}

/** The prepared variant a large raster share image is copied from, or null when the image is fine as it is. */
export function shareDerivativeSource(publication, url) {
  const resolved = publication.reference_mapping?.media?.find(([from]) => from === url)?.[1] ?? url;
  const item = (publication.media ?? []).find(candidate => candidate.cdn_url === resolved);
  if (!item || !RASTER_SHARE.has(essence(item.mime_type))) return null;
  if (!(Number(item.size_bytes) > SHARE_MAX_BYTES || Number(item.width) > SHARE_WIDTH)) return null;
  const variants = (item.variants ?? []).filter(variant => variant.format === 'webp' && typeof variant.cdn_url === 'string'
    && /^[a-f0-9]{64}$/.test(variant.sha256 ?? '') && Number.isSafeInteger(variant.width));
  if (!variants.length) return null;
  const width = shareVariantWidth(variants.map(variant => variant.width));
  const chosen = variants.find(variant => variant.width === width);
  return { url: chosen.cdn_url, sha256: chosen.sha256, size_bytes: chosen.size_bytes };
}

/** A JPEG at most 1200 px wide, keeping the aspect ratio, under about 300 kB. */
export async function renderShareDerivative(bytes) {
  const options = { limitInputPixels: 40_000_000, failOn: 'error' };
  let quality = 82, output;
  do {
    output = await sharp(bytes, options).rotate().resize({ width: SHARE_WIDTH, withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    quality -= 10;
  } while (output.data.length > SHARE_MAX_BYTES && quality >= 52);
  return { bytes: output.data, width: output.info.width, height: output.info.height };
}

const decodeAttr = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encodeAttr = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const OG_IMAGE = /<meta\s+property="og:image"\s+content="([^"]*)"\s*\/?>/;

/**
 * Rewrite every built page whose og:image is a non-raster publication image
 * to a PNG copy. A copy that cannot be made leaves the page as it was: the
 * share image is never a reason to fail a publication.
 */
export async function writeShareImages(dist, publication, readImage, readVariant = async () => null) {
  const background = backgroundColor(publication.settings);
  const rendered = new Map();
  async function shareUrl(url) {
    if (rendered.has(url)) return rendered.get(url);
    let result = null;
    try {
      if (rendered.size < MAX_SHARE_IMAGES) {
        const bytes = await readImage(url);
        if (bytes) {
          const png = await renderShareImage(Buffer.from(bytes), background);
          const relative = `/_assets/share/share-${digest(png)}.png`;
          await fs.mkdir(path.join(dist, '_assets/share'), { recursive: true });
          await fs.writeFile(path.join(dist, relative), png);
          result = new URL(relative, publication.site_url).href;
        }
      }
    } catch (error) {
      // Do not reflect URLs or decoder output in public logs.
      console.warn(`share_image_copy_skipped: ${error instanceof Error ? error.name : 'error'}`);
    }
    rendered.set(url, result);
    return result;
  }
  const derived = new Map();
  async function derivative(url) {
    if (derived.has(url)) return derived.get(url);
    let result = null;
    const source = shareDerivativeSource(publication, url);
    try {
      if (source && derived.size < MAX_DERIVATIVES) {
        const bytes = await readVariant(source);
        if (bytes && createHash('sha256').update(bytes).digest('hex') === source.sha256) {
          const copy = await renderShareDerivative(Buffer.from(bytes));
          const relative = `/_assets/share/share-${digest(copy.bytes)}.jpg`;
          await fs.mkdir(path.join(dist, '_assets/share'), { recursive: true });
          await fs.writeFile(path.join(dist, relative), copy.bytes);
          result = { url: new URL(relative, publication.site_url).href, width: copy.width, height: copy.height };
        }
      }
    } catch (error) {
      console.warn(`share_image_copy_skipped: ${error instanceof Error ? error.name : 'error'}`);
    }
    derived.set(url, result);
    return result;
  }
  const replaceTags = (html, url, type, width, height) => {
    const attr = encodeAttr(url);
    return html
      .replace(/<meta\s+property="og:image:(?:type|width|height)"\s+content="[^"]*"\s*\/?>/g, '')
      .replace(OG_IMAGE, `<meta property="og:image" content="${attr}"><meta property="og:image:type" content="${type}"><meta property="og:image:width" content="${width}"><meta property="og:image:height" content="${height}">`)
      .replace(/(<meta\s+name="twitter:image"\s+content=")[^"]*("\s*\/?>)/, `$1${attr}$2`);
  };
  let pages = 0;
  async function rewrite(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await rewrite(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const html = await fs.readFile(file, 'utf8');
      const match = html.match(OG_IMAGE);
      if (!match) continue;
      const original = decodeAttr(match[1]);
      const entryMatch = publication.media_manifest?.entries.some(candidate => isShareImageEntry(publication, candidate) && matchesEntry(publication, candidate, original));
      let next = html;
      if (entryMatch) {
        const replacement = await shareUrl(original);
        if (replacement) next = replaceTags(html, replacement, 'image/png', SHARE_WIDTH, SHARE_HEIGHT);
      } else {
        const copy = await derivative(original);
        if (copy) next = replaceTags(html, copy.url, 'image/jpeg', copy.width, copy.height);
      }
      if (next !== html) { await fs.writeFile(file, next); pages++; }
    }
  }
  await rewrite(dist);
  return { pages, images: [...rendered.values(), ...derived.values()].filter(Boolean).length };
}
