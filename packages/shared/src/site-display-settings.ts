/**
 * Small per-site display settings: how dates read and how wide the shared
 * content widths are. Both apply from render version 14.
 */

/** Named date formats; any other value is a pattern of YYYY, MMMM, MMM, MM, M, DD and D. */
export const DATE_FORMAT_PRESETS = ['medium', 'long', 'numeric', 'iso'] as const;
export type DateFormatPreset = typeof DATE_FORMAT_PRESETS[number];

export function dateFormatError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 40) {
    return `date_format must be one of ${DATE_FORMAT_PRESETS.join(', ')}, or a pattern such as "D MMMM YYYY" (at most 40 characters)`;
  }
  if ((DATE_FORMAT_PRESETS as readonly string[]).includes(value)) return null;
  return /YYYY|M|D/.test(value) ? null : 'date_format pattern must contain YYYY, a month (M, MM, MMM, MMMM) or a day (D, DD)';
}

/** A valid IANA time zone name, such as Europe/Stockholm. */
export function timeZoneError(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value) || value.length > 64) return 'time_zone must be an IANA time zone such as Europe/Stockholm';
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return null; } catch { return `${value} is not a time zone this runtime knows`; }
}

export interface ContentWidths { narrow?: number; normal?: number; wide?: number }

/** Defaults in px (42, 65 and 80rem) and the range each width accepts. */
export const CONTENT_WIDTH_DEFAULTS: Required<ContentWidths> = { narrow: 672, normal: 1040, wide: 1280 };
export const CONTENT_WIDTH_LIMITS: Record<keyof ContentWidths, [number, number]> = { narrow: [480, 1200], normal: [720, 1600], wide: [960, 2400] };

export function contentWidthsError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'content_widths must be an object such as { "narrow": 672, "normal": 1040, "wide": 1280 } (px)';
  for (const [key, width] of Object.entries(value)) {
    const limits = CONTENT_WIDTH_LIMITS[key as keyof ContentWidths];
    if (!limits) return `content_widths.${key} is not a width; use narrow, normal or wide`;
    if (!Number.isInteger(width) || (width as number) < limits[0] || (width as number) > limits[1]) return `content_widths.${key} must be a whole number of px from ${limits[0]} to ${limits[1]}`;
  }
  const resolved = { ...CONTENT_WIDTH_DEFAULTS, ...(value as ContentWidths) };
  return resolved.narrow <= resolved.normal && resolved.normal <= resolved.wide ? null : 'content_widths must keep narrow ≤ normal ≤ wide';
}

/** Custom properties for the shared content widths, with a site's own values where valid. */
export function contentWidthsCss(value: unknown): string {
  const own = value && !contentWidthsError(value) ? value as ContentWidths : {};
  const width = (key: keyof ContentWidths) => own[key] ? `${own[key]}px` : `${CONTENT_WIDTH_DEFAULTS[key] / 16}rem`;
  return `--content-narrow:${width('narrow')};--content-normal:${width('normal')};--content-wide:${width('wide')};`;
}
