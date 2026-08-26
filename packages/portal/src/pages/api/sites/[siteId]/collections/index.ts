import type { APIRoute } from 'astro';
import { vstore } from '../../../../../lib/version-store';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import {
  getCollectionStarter,
  inferStarterKind,
  paths,
  type CollectionStarterKind,
} from '@typeroll/shared';
import type { Block, CollectionDef } from '@typeroll/shared';

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const body = (await request.json()) as Partial<CollectionDef>;
  const name = String(body.name ?? '').trim();
  if (!NAME_RE.test(name)) return json({ error: 'name must be lowercase letters/numbers/underscores starting with a letter' }, 400);
  if (!body.label_singular || !body.label_plural) return json({ error: 'labels required' }, 400);
  if (!Array.isArray(body.fields) || body.fields.length === 0) return json({ error: 'at least one field required' }, 400);

  const store = getStore();
  const existing = await vstore.collection(owner_org_id, site.id, versionId, name);
  if (existing) return json({ error: `Collection "${name}" already exists` }, 409);

  // Pick an `item_template_blocks` starter when the caller didn't supply
  // one. New collections default to block-mode rendering — the wizard's
  // template kind drives the starter; direct callers can opt out by
  // passing `item_template_html` or an explicit `item_template_blocks`.
  type CreateBody = Partial<CollectionDef> & { template_kind?: CollectionStarterKind };
  const createBody = body as CreateBody;
  let item_template_blocks: Block[] | undefined =
    Array.isArray(createBody.item_template_blocks)
      ? (createBody.item_template_blocks as Block[])
      : undefined;
  if (!item_template_blocks && !body.item_template_html) {
    const kind = createBody.template_kind ?? inferStarterKind(body.fields);
    item_template_blocks = getCollectionStarter(kind);
  }

  const doc: Omit<CollectionDef, 'id'> = {
    name,
    label_singular: String(body.label_singular),
    label_plural: String(body.label_plural),
    icon: body.icon ?? '📋',
    fields: body.fields,
    slug_field: body.slug_field,
    sort_field: body.sort_field,
    sort_dir: body.sort_dir ?? 'desc',
    item_template_html: body.item_template_html,
    item_template_blocks,
    created_at: new Date().toISOString(),
  };
  await store.setDoc(paths.collection(owner_org_id, site.id, name, versionId), doc);
  return json({ ok: true, name });
};

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const list = await getStore().listDocs<CollectionDef>(paths.collections(owner_org_id, site.id, versionId));
  return json(list);
};
