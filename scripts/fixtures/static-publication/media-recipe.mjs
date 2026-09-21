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
