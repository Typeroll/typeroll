// Shared pieces of the collection routes (session and v1).

import { readCollectionEntry, collectionFailureBody } from './collections';
import { vstore } from '../version-store';
import type { CollectionEntry } from '@typeroll/shared';

/** The site's render version, which the built-in header and footer follow. */
export async function siteRenderVersion(orgId: string, siteId: string, versionId: string): Promise<number | undefined> {
  const settings = await vstore.settings(orgId, siteId, versionId);
  return typeof settings?.render_version === 'number' ? settings.render_version : undefined;
}

export async function entryForSite(orgId: string, siteId: string, versionId: string, entryId: string | undefined): Promise<CollectionEntry | null> {
  if (!entryId) return null;
  return readCollectionEntry(orgId, entryId, { renderVersion: await siteRenderVersion(orgId, siteId, versionId) });
}

export const collectionPreviewBase = (prefix: '/api/sites' | '/api/v1/sites', siteId: string) => `${prefix}/${encodeURIComponent(siteId)}/collection`;

/** A refused request as `{ status, body }`; unexpected errors are rethrown. */
export function collectionRefusal(error: unknown): { status: number; body: { error: string; code: string; details?: Record<string, unknown> } } {
  const refused = collectionFailureBody(error);
  if (!refused) throw error;
  return refused;
}

/** A preview file answer: private, revalidated by its content address. */
export function mediaResponse(file: { bytes: Uint8Array; contentType: string; filename: string }): Response {
  return new Response(file.bytes as unknown as BodyInit, { headers: {
    'Content-Type': file.contentType,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    ...(file.contentType === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
  } });
}

/** Who acts over the API: the key, and the app when an installation credential is used. */
export function apiCollectionActor(ctx: { keyPrefix: string; extensionIdentity?: { extensionId?: string } }) {
  return { label: ctx.keyPrefix.startsWith('extension:') ? ctx.keyPrefix : `api-key:${ctx.keyPrefix}`, ...(ctx.extensionIdentity?.extensionId ? { extensionId: ctx.extensionIdentity.extensionId } : {}) };
}
