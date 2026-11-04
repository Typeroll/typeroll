/** Shared by exact-object grants, preparation, export and explicit API generation. */
export const MEDIA_RECIPE_VERSION = 'v2';
export const MEDIA_VARIANT_WIDTHS = [320, 640, 1024, 1920];
// Original dimensions may be unknown until the customer runner reads the image.
// A fixed original slot grants one exact object without granting arbitrary keys.
export const MEDIA_VARIANT_SLOTS = [...MEDIA_VARIANT_WIDTHS.map(width => `w${width}`), 'original'];
export function mediaVariantCandidates(sourceWidth) {
  if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1) throw new Error('Invalid source image width');
  return [...MEDIA_VARIANT_WIDTHS.filter(width => width < sourceWidth).map(width => ({ width, slot: `w${width}` })),
    { width: sourceWidth, slot: 'original' }];
}
export function mediaVariantSuffix(slot, sourceHash, format) {
  if (!MEDIA_VARIANT_SLOTS.includes(slot) || !/^[a-f0-9]{64}$/.test(sourceHash) || !['webp', 'avif'].includes(format)) throw new Error('Invalid media variant');
  return `.${MEDIA_RECIPE_VERSION}.${slot}.${sourceHash.slice(0, 16)}.${format}`;
}

// Share copies (og:image) of images served from a separate media host live
// next to their source in the site's R2 namespace. Their key is derived from
// the source bytes and the recipe, never from the output, so Typeroll can
// grant the exact object before the build and an unchanged copy is reused.
export const SHARE_RECIPE_VERSION = 's1';
const SHARE_CARD_TYPES = new Set(['image/svg+xml', 'image/avif', 'image/tiff']);
const SHARE_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** `card` letterboxes a format networks cannot show into a PNG; `photo` scales a large raster down to a JPEG. */
export function shareCopyKind(mimeType) {
  const type = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return SHARE_CARD_TYPES.has(type) ? 'card' : SHARE_PHOTO_TYPES.has(type) ? 'photo' : null;
}
/** The site background a card is letterboxed on, as #rrggbb. */
export function shareBackground(value) {
  const color = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(digit => digit + digit).join('');
  return '#ffffff';
}
export function shareCopySuffix(kind, sourceHash, background = '#ffffff') {
  if (!['card', 'photo'].includes(kind) || !/^[a-f0-9]{64}$/.test(sourceHash) || !/^#[0-9a-f]{6}$/.test(background)) throw new Error('Invalid share copy');
  return kind === 'card' ? `.share-${SHARE_RECIPE_VERSION}.card.${sourceHash.slice(0, 16)}.${background.slice(1)}.png` : `.share-${SHARE_RECIPE_VERSION}.photo.${sourceHash.slice(0, 16)}.jpg`;
}
/** Whether a manifest serves its images from a host other than the website. */
export function separateMediaHost(manifest) {
  return Boolean(manifest) && manifest.delivery !== 'static' && manifest.media_host !== manifest.website_host;
}
/** The share copy an entry may have on its media host, or null. */
export function shareCopyTarget(manifest, entry) {
  const kind = entry.share_source === true && separateMediaHost(manifest) ? shareCopyKind(entry.mime_type) : null;
  if (!kind || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) return null;
  const suffix = shareCopySuffix(kind, entry.sha256, shareBackground(manifest.share_background));
  return { kind, suffix, key: entry.public_key + suffix, url: entry.cdn_url + suffix, receipt_key: entry.public_key + suffix + '.receipt.json',
    receipt_url: entry.cdn_url + suffix + '.receipt.json', mime_type: kind === 'card' ? 'image/png' : 'image/jpeg' };
}
