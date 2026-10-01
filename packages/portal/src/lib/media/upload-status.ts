// Whether media uploads can go through for a site right now — the pre-flight
// behind the media library banner (/api/sites/{siteId}/media/upload-status)
// and the public API (/api/v1/sites/{siteId}/media/upload-status, MCP
// `get_media_upload_status`). One implementation so an agent sees the same
// answer, and the same reason, as the person in the portal.

import type { Site } from '@typeroll/shared';
import { usesPrivateMedia } from '../publishing/media-policy';

export interface MediaUploadStatus {
  enabled: boolean;
  /** Human-readable reason when uploads are unavailable. */
  reason?: string;
  /** Server environment variables that are missing (self-hosted platform storage). */
  missing?: string[];
  /** Portal page where the organization fixes its storage connection. */
  settings_url?: string;
  /** Upload destination when the organization's own storage is used. */
  storage?: string;
}

const PLATFORM_R2_ENV = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

export async function mediaUploadStatus(
  ownerOrgId: string,
  site: Pick<Site, 'publishing_mode' | 'hosting_config'>,
): Promise<MediaUploadStatus> {
  if (await usesPrivateMedia(ownerOrgId, site)) {
    const { mediaUploadAvailability } = await import('../publishing/media-storage');
    try {
      return await mediaUploadAvailability(ownerOrgId);
    } catch (error) {
      return {
        enabled: false,
        reason: error instanceof Error ? error.message : 'Media storage is unavailable. Open Publishing to check the connection.',
        settings_url: '/app/settings/publishing',
      };
    }
  }
  const missing = PLATFORM_R2_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return {
      enabled: false,
      reason: `Media uploads require Cloudflare R2 credentials. Missing on the server: ${missing.join(', ')}.`,
      missing,
    };
  }
  return { enabled: true };
}
