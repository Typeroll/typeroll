export const MAX_ICON_BYTES: number;
export function writeSiteIcons(dist: string, settings: { site_name?: string; favicon?: string; icon_192?: string }, readImage: (url: string) => Promise<Uint8Array>): Promise<{ favicon_url: string; icon_192_url: string }>;
