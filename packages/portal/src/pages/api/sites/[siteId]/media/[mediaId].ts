import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

const EDITABLE: Array<keyof Media> = ['filename', 'alt_text', 'title', 'caption', 'width', 'height'];

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const doc = await getStore().getDoc<Media>(`${paths.media(owner_org_id, site.id)}/${mediaId}`);
  if (!doc) return json({ error: 'Not found' }, 404);
  return json(doc);
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const body = (await request.json()) as Partial<Media>;
  const update: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in body) update[k] = body[k];

  const docPath = `${paths.media(owner_org_id, site.id)}/${mediaId}`;
  const existing = await getStore().getDoc<Media>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  await getStore().updateDoc(docPath, update);
  return json({ ok: true });
};

/**
 * Remove a media item: drop the underlying R2 object, then delete the doc.
 * The order matters — if the R2 delete fails we still want the doc gone so
 * the user can re-upload without the library claiming the name is taken.
 * Worst case is an orphan R2 object, which we'd rather have than a
 * dangling-link in the UI.
 */
export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { mediaId } = params;
  if (!mediaId) return json({ error: 'Missing mediaId' }, 400);

  const store = getStore();
  const docPath = `${paths.media(owner_org_id, site.id)}/${mediaId}`;
  const existing = await store.getDoc<Media>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  // Best-effort R2 cleanup. Only attempts when R2 is configured AND we have
  // the object key stored on the doc (older uploads predate the r2_key field).
  if (existing.r2_key && process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET) {
    try {
      const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      });
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: existing.r2_key }));
    } catch {
      // Swallow — leaves an orphan object but doesn't block the user from
      // freeing up the slot in the library.
    }
  }

  await store.deleteDoc(docPath);
  return json({ ok: true });
};
