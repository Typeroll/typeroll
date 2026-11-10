// Permanent deletion of an archived site by an owner of its organization.
//
// Two steps, so neither a person nor an agent deletes the wrong thing by
// accident:
//
//   1. `siteDeletionInventory` lists what deletion would remove (documents per
//      collection, per version), what blocks it, and what it leaves untouched
//      in the customer's own accounts, and fingerprints all of that as a
//      `digest`. Nothing is written.
//   2. `deleteSite` takes the site id and that digest back, re-derives the
//      inventory and refuses unless both still match. The confirmation is
//      therefore of one exact inventory of one site.
//
// What is deleted: every document beneath the site (its versions with pages,
// partials and revisions, extension installations with their credentials and
// launch grants, keys, shares, forms, submissions, deploy history, audit
// trail…) and then the site document itself. The site's API keys are revoked
// first, and index entries other organizations hold for revoked shares are
// removed, so nothing keeps pointing at the site.
//
// What is not: anything in the customer's own accounts — the generated Git
// repository, the Cloudflare Pages project that keeps serving the last
// publication, DNS records, the organization's build engine and media storage
// shared with other sites. Core cannot reach those safely and they are the
// customer's; the inventory lists them with what to do. Media objects are
// purged beforehand (`media_present` blocks until `purge_site_media` ran),
// because that purge reports partial failures that need their own retry.
// A site in the `hosted` publishing mode is retired on the bound hosting
// service, which Core owns through the binding and whose retirement is
// idempotent.
//
// Interruption: documents are deleted leaf first — each version in one store
// transaction with its content and revisions, then nested documents deepest
// first, then the site's own collections, and the site document last — so a
// stopped run leaves orphans beneath a site that still exists, never a site
// pointing at half its content. A confirmed run records itself on the site
// (`lifecycle.deletion`), and repeating the same request continues from where
// it stopped. One call does a bounded amount of work and answers 202 with what
// remains when there is more.
//
// Every attempt by an owner writes an audit record on the organization
// (`organizations/{org}/site_deletions/{id}`), which outlives the site.

import { createHash, randomUUID } from 'node:crypto';
import { isArchivedSite, paths } from '@typeroll/shared';
import type { ExtensionInstallation, Site, SiteApiKey, SiteShare } from '@typeroll/shared';
import { getStore } from './datastore';
import { revokeApiKey } from './api-keys';
import { siteLifecycleState, servedCustomDomain, isGeneratedSiteAddress } from './site-lifecycle';
import { generatedCloudflareNames } from './publishing/cloudflare-account-claims';
import { isHostedSite, retireHostedSite, siteHostingAvailable } from './publishing/site-hosting';
import { ConnectionError } from './publishing/connections';

/** Store operations one call may spend before answering 202 with what remains. */
export const SITE_DELETION_OPERATION_BUDGET = 400;

export type SiteDeletionBlockerCode =
  | 'not_archived'
  | 'domain_serving'
  | 'shared_with_other_orgs'
  | 'media_present'
  | 'hosting_service_unavailable'
  | 'store_cannot_enumerate';

export interface SiteDeletionBlocker {
  code: SiteDeletionBlockerCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Something outside Core's documents that deletion leaves alone, or removes on a service Core owns. */
export interface ExternalResource {
  kind: string;
  name?: string;
  message: string;
}

export interface SiteDeletionCounts {
  /** Every document deletion would remove, the site document included. */
  total: number;
  /** Site-level collections, by path relative to the site (`*` for a document id). */
  collections: Record<string, number>;
  /** Each version: its own document plus its content, by collection path relative to the version. */
  versions: Record<string, { total: number; collections: Record<string, number> }>;
}

export interface SiteDeletionInventory {
  site: string;
  organization_id: string;
  status: 'ready' | 'blocked' | 'in_progress';
  lifecycle: Record<string, unknown>;
  documents: SiteDeletionCounts;
  /** Active site API keys, revoked before anything is deleted. */
  api_keys_to_revoke: string[];
  shares: { live: number; revoked: number };
  blockers: SiteDeletionBlocker[];
  /** Resources deletion does not touch, and what to do about each. */
  untouched: ExternalResource[];
  /** Resources outside the documents that deletion also removes. */
  also_removed: ExternalResource[];
  digest: string;
  deletion?: NonNullable<NonNullable<Site['lifecycle']>['deletion']>;
  /** Exactly what to send to delete, present only when nothing blocks. */
  confirm?: { method: 'POST'; path: string; body: { confirm_site_id: string; confirm_digest: string; reason?: string } };
  message: string;
}

export interface SiteDeletionActor {
  user_id?: string;
  key_prefix: string;
}

export interface SiteDeletionOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface AuditRecord {
  site_id: string;
  org_id: string;
  status: 'started' | 'succeeded' | 'refused' | 'unconfirmed';
  actor: SiteDeletionActor;
  digest?: string;
  reason?: string;
  refusal?: { code: string; blockers?: string[] };
  revoked_api_keys?: string[];
  /** Documents in the confirmed inventory, the site document included. */
  documents_total?: number;
  deleted_documents?: number;
  runs?: number;
  started_at: string;
  updated_at: string;
  finished_at?: string;
}

const sitePrefixLength = (orgId: string, siteId: string) => paths.site(orgId, siteId).split('/').length;

/** Every document path beneath the site, in path order. */
async function siteTree(orgId: string, siteId: string): Promise<string[] | null> {
  const store = getStore();
  if (typeof store.listTree !== 'function') return null;
  const root = paths.site(orgId, siteId);
  const out: string[] = [];
  const limit = 1000;
  let after: string | undefined;
  for (;;) {
    const page = await store.listTree(root, { ...(after ? { after } : {}), limit });
    out.push(...page);
    if (page.length < limit) return out;
    after = page[page.length - 1];
  }
}

/** `a/1/b/2` → `a/*\/b`: a collection path with document ids masked. */
function collectionKey(segments: string[]): string {
  return segments.slice(0, -1).map((segment, index) => (index % 2 === 1 ? '*' : segment)).join('/');
}

function countTree(orgId: string, siteId: string, tree: string[]): SiteDeletionCounts {
  const depth = sitePrefixLength(orgId, siteId);
  const counts: SiteDeletionCounts = { total: tree.length + 1, collections: {}, versions: {} };
  for (const item of tree) {
    const rel = item.split('/').slice(depth);
    if (rel[0] === 'versions' && rel.length >= 2) {
      const version = (counts.versions[rel[1]!] ??= { total: 0, collections: {} });
      version.total += 1;
      if (rel.length > 2) {
        const key = collectionKey(rel.slice(2));
        version.collections[key] = (version.collections[key] ?? 0) + 1;
      }
      continue;
    }
    const key = collectionKey(rel);
    counts.collections[key] = (counts.collections[key] ?? 0) + 1;
  }
  return counts;
}

/** Deterministic JSON: object keys sorted, so the digest does not depend on read order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function externalResources(orgId: string, site: Site & { id: string }, tree: string[], counts: SiteDeletionCounts): { untouched: ExternalResource[]; also_removed: ExternalResource[] } {
  const untouched: ExternalResource[] = [];
  const also_removed: ExternalResource[] = [];
  const depth = sitePrefixLength(orgId, site.id);
  if (isHostedSite(site)) {
    also_removed.push({
      kind: 'hosted_site',
      ...(site.hosting_config?.fallback_subdomain ? { name: site.hosting_config.fallback_subdomain } : {}),
      message: 'The hosting service removes the site\'s platform address and stored publications, so the website stops answering.',
    });
  } else {
    const generated = generatedCloudflareNames(orgId, site.id);
    const published = Boolean(site.git_repository || site.publishing_migration || (counts.collections.deploys ?? 0) > 0);
    if (published) {
      untouched.push({
        kind: 'git_repository',
        name: site.git_repository ?? generated.pages_project!,
        message: 'The repository with the generated site source in your organization\'s GitHub account is not deleted. Delete or archive it in GitHub when you no longer need it.',
      });
      untouched.push({
        kind: 'pages_project',
        name: site.publishing_migration?.project ?? (typeof site.hosting_config?.pages_project === 'string' ? site.hosting_config.pages_project : generated.pages_project!),
        message: 'The Cloudflare Pages project in your hosting account keeps serving the last publication at its pages.dev address and the site\'s generated address. Delete the project in Cloudflare to take the website down.',
      });
      untouched.push({
        kind: 'build_engine',
        message: 'Your organization\'s build engine is shared by all its sites and is not changed.',
      });
    }
  }
  if (site.domain && !isGeneratedSiteAddress(orgId, site.id, site.domain)) {
    untouched.push({
      kind: 'dns_records',
      name: site.domain,
      message: `Remove any DNS records you created for ${site.domain} at your DNS provider.`,
    });
  }
  const fonts = tree.filter(item => { const rel = item.split('/').slice(depth); return rel[0] === 'fonts' && rel.length === 2; }).length;
  if (fonts > 0) {
    untouched.push({
      kind: 'font_files',
      message: `${fonts} uploaded font file${fonts === 1 ? '' : 's'} stored in your organization's private media storage stay there (private, never publicly addressed). Delete fonts with delete_font before deleting the site to remove them.`,
    });
  }
  return { untouched, also_removed };
}

async function installations(orgId: string, siteId: string): Promise<Array<ExtensionInstallation & { id: string }>> {
  return getStore().listDocs<ExtensionInstallation>(paths.extensionInstallations(orgId, siteId));
}

/**
 * The inventory of `site` as deletion would see it now. Read-only. `confirmPath`
 * is the route the caller sends the confirmation to.
 */
export async function siteDeletionInventory(orgId: string, site: Site & { id: string }, confirmPath: string): Promise<SiteDeletionInventory> {
  const store = getStore();
  const tree = await siteTree(orgId, site.id);
  const counts = countTree(orgId, site.id, tree ?? []);
  const [keys, shares, apps] = await Promise.all([
    store.listDocs<SiteApiKey>(paths.apiKeys(orgId, site.id)),
    store.listDocs<SiteShare>(paths.shares(orgId, site.id)),
    installations(orgId, site.id),
  ]);
  const liveShares = shares.filter(share => !share.revoked_at);
  const media = counts.collections.media ?? 0;

  const blockers: SiteDeletionBlocker[] = [];
  if (tree === null) {
    blockers.push({ code: 'store_cannot_enumerate', message: 'This installation\'s datastore cannot list a site\'s documents, so it cannot delete a site completely. Nothing was deleted.' });
  }
  if (!isArchivedSite(site)) {
    blockers.push({ code: 'not_archived', message: 'Archive the site first (archive_site, or POST /api/v1/sites/{siteId}/lifecycle with {"action":"archive"}).' });
  }
  const domain = servedCustomDomain(orgId, site);
  if (domain) {
    blockers.push({ code: 'domain_serving', message: `The site still serves ${domain}. Move or remove the domain first.`, details: { domain, domain_status: site.domain_status } });
  }
  if (liveShares.length > 0) {
    blockers.push({
      code: 'shared_with_other_orgs',
      message: 'The site is shared with other organizations. Revoke the shares first (revoke_site_share).',
      details: { shares: liveShares.map(share => ({ id: share.id, shared_with_org_id: share.shared_with_org_id, permission: share.permission })) },
    });
  }
  if (media > 0) {
    blockers.push({ code: 'media_present', message: `The site still has ${media} media record${media === 1 ? '' : 's'}. Run purge_site_media (POST /api/v1/sites/{siteId}/media/purge) first.`, details: { media_records: media } });
  }
  if (isHostedSite(site) && !siteHostingAvailable()) {
    blockers.push({ code: 'hosting_service_unavailable', message: 'The site is served by a hosting service this installation cannot reach, so it cannot be taken off that service. Nothing was deleted.' });
  }

  const external = externalResources(orgId, site, tree ?? [], counts);
  for (const app of apps) {
    external.untouched.push({
      kind: 'extension_data',
      name: app.extension_id,
      message: `The installation of ${app.extension_id} and its credentials are deleted, so the app can no longer reach this site. Data the app keeps in its own storage is not; ask its provider to delete it.`,
    });
  }

  const apiKeys = keys.filter(key => !key.revoked_at).map(key => key.id).sort();
  const lifecycle = siteLifecycleState(site);
  const fingerprint = {
    organization_id: orgId,
    site: site.id,
    archived_at: site.lifecycle?.archived_at ?? null,
    documents: counts,
    api_keys_to_revoke: apiKeys,
    shares: shares.map(share => `${share.id}:${share.revoked_at ? 'revoked' : 'live'}`).sort(),
    blockers: blockers.map(blocker => blocker.code),
    untouched: external.untouched,
    also_removed: external.also_removed,
  };
  const deletion = site.lifecycle?.deletion;
  const digest = deletion?.digest ?? `sha256:${createHash('sha256').update(canonical(fingerprint)).digest('hex')}`;
  const status: SiteDeletionInventory['status'] = blockers.length ? 'blocked' : deletion ? 'in_progress' : 'ready';

  return {
    site: site.id,
    organization_id: orgId,
    status,
    lifecycle,
    documents: counts,
    api_keys_to_revoke: apiKeys,
    shares: { live: liveShares.length, revoked: shares.length - liveShares.length },
    blockers,
    untouched: external.untouched,
    also_removed: external.also_removed,
    digest,
    ...(deletion ? { deletion } : {}),
    ...(blockers.length ? {} : { confirm: { method: 'POST' as const, path: confirmPath, body: { confirm_site_id: site.id, confirm_digest: digest } } }),
    message: status === 'blocked'
      ? 'Nothing has been deleted. Resolve the blockers, then read this inventory again.'
      : status === 'in_progress'
        ? 'A confirmed deletion of this site was interrupted. Send the confirmation again to finish it; the site cannot be restored.'
        : 'Nothing has been deleted. Deleting is permanent and cannot be undone: show this inventory to an owner of the organization and send the confirmation only after they agree.',
  };
}

async function writeAudit(orgId: string, id: string, record: AuditRecord): Promise<void> {
  await getStore().setDoc(paths.siteDeletion(orgId, id), record as unknown as Record<string, unknown>);
}

/** An owner's attempt that changed nothing still leaves a record. */
async function recordRefusal(orgId: string, siteId: string, actor: SiteDeletionActor, status: 'refused' | 'unconfirmed', code: string, extra: { digest?: string; reason?: string; blockers?: string[] }): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await writeAudit(orgId, id, {
    site_id: siteId, org_id: orgId, status, actor,
    ...(extra.digest ? { digest: extra.digest } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    refusal: { code, ...(extra.blockers ? { blockers: extra.blockers } : {}) },
    started_at: now, updated_at: now, finished_at: now,
  });
  return id;
}

/**
 * Delete `site` permanently once `input` confirms the current inventory.
 * Authorization (owner authority in the owning organization) is the caller's.
 */
export async function deleteSite(input: {
  orgId: string;
  site: Site & { id: string };
  body: unknown;
  actor: SiteDeletionActor;
  confirmPath: string;
  operationBudget?: number;
}): Promise<SiteDeletionOutcome> {
  const { orgId, site, actor, confirmPath } = input;
  const budget = Math.max(1, input.operationBudget ?? SITE_DELETION_OPERATION_BUDGET);
  const body = input.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Invalid JSON body', code: 'invalid_body' } };
  }
  const { confirm_site_id: confirmSiteId, confirm_digest: confirmDigest, reason: rawReason } = body as Record<string, unknown>;
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';
  const inventory = await siteDeletionInventory(orgId, site, confirmPath);

  if (confirmSiteId !== site.id) {
    const audit = await recordRefusal(orgId, site.id, actor, 'unconfirmed', 'confirm_site_id_mismatch', { reason });
    return {
      status: 400,
      body: {
        error: `confirm_site_id must be exactly "${site.id}", the site in the request path. Nothing was deleted.`,
        code: 'confirm_site_id_mismatch',
        details: { site: site.id, organization_id: orgId, audit_id: audit },
      },
    };
  }
  if (typeof confirmDigest !== 'string' || confirmDigest !== inventory.digest) {
    const audit = await recordRefusal(orgId, site.id, actor, 'unconfirmed', 'site_deletion_digest_stale', { reason, ...(typeof confirmDigest === 'string' ? { digest: confirmDigest.slice(0, 100) } : {}) });
    return {
      status: 409,
      body: {
        error: typeof confirmDigest === 'string'
          ? 'The site changed since this inventory was read, or the digest belongs to another inventory. Nothing was deleted. Read the inventory again (GET /api/v1/sites/{siteId}/deletion) and confirm it with the owner.'
          : 'confirm_digest is required: read the inventory (GET /api/v1/sites/{siteId}/deletion) and send its digest. Nothing was deleted.',
        code: typeof confirmDigest === 'string' ? 'site_deletion_digest_stale' : 'confirm_digest_required',
        details: { site: site.id, organization_id: orgId, audit_id: audit },
      },
    };
  }
  if (inventory.blockers.length) {
    const audit = await recordRefusal(orgId, site.id, actor, 'refused', 'site_deletion_blocked', { reason, digest: inventory.digest, blockers: inventory.blockers.map(blocker => blocker.code) });
    return {
      status: 409,
      body: {
        error: 'This site cannot be deleted yet. Nothing was deleted.',
        code: 'site_deletion_blocked',
        details: { site: site.id, organization_id: orgId, blockers: inventory.blockers, audit_id: audit },
      },
    };
  }

  const store = getStore();
  const sitePath = paths.site(orgId, site.id);
  const now = new Date().toISOString();

  // Record the confirmed deletion on the site before anything is removed, so
  // an interrupted run can be resumed (and not restored) from any point.
  let marker = site.lifecycle?.deletion;
  let audit: AuditRecord | null = null;
  if (!marker) {
    const started = { status: 'in_progress' as const, started_at: now, started_by: actor.user_id ?? `api-key:${actor.key_prefix}`, audit_id: randomUUID(), digest: inventory.digest };
    // Conditional, so two concurrent confirmations start one deletion.
    const won = await store.compareAndUpdateDoc<Site>(sitePath, current => isArchivedSite(current) && !current.lifecycle?.deletion,
      { lifecycle: { ...site.lifecycle, deletion: started } });
    if (won) {
      marker = started;
      audit = {
        site_id: site.id, org_id: orgId, status: 'started', actor, digest: inventory.digest,
        ...(reason ? { reason } : {}), revoked_api_keys: [], documents_total: inventory.documents.total, deleted_documents: 0, runs: 0, started_at: now, updated_at: now,
      };
      await writeAudit(orgId, marker.audit_id, audit);
    } else {
      marker = (await store.getDoc<Site>(sitePath))?.lifecycle?.deletion;
      if (!marker) return { status: 409, body: { error: 'The site changed while the deletion was being confirmed. Nothing was deleted. Read the inventory again.', code: 'site_deletion_digest_stale' } };
    }
  }
  if (!audit) {
    const stored = await store.getDoc<AuditRecord>(paths.siteDeletion(orgId, marker.audit_id));
    if (stored) delete (stored as { id?: string }).id;
    audit = stored ?? {
      site_id: site.id, org_id: orgId, status: 'started', actor, digest: marker.digest, revoked_api_keys: [], documents_total: inventory.documents.total, deleted_documents: 0, runs: 0, started_at: marker.started_at, updated_at: now,
    };
  }
  const auditId = marker.audit_id;
  audit.runs = (audit.runs ?? 0) + 1;

  // 1. Take the site off a hosting service Core owns. Idempotent.
  if (isHostedSite(site)) {
    try {
      await retireHostedSite(orgId, site.id);
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      audit.updated_at = new Date().toISOString();
      await writeAudit(orgId, auditId, audit);
      return {
        status: error.status >= 500 ? 503 : error.status,
        body: {
          error: `${error.message} The deletion has started and nothing of the site's content was removed yet; send the same request again to continue.`,
          code: error.code ?? 'site_hosting_unreachable',
          details: { site: site.id, organization_id: orgId, audit_id: auditId, retryable: true },
        },
      };
    }
  }

  // 2. Revoke the site's API keys before deleting anything, so no key keeps
  //    working against a half-deleted site.
  const revoked = new Set(audit.revoked_api_keys ?? []);
  for (const prefix of inventory.api_keys_to_revoke) {
    if (await revokeApiKey(orgId, site.id, prefix)) revoked.add(prefix);
  }
  audit.revoked_api_keys = [...revoked].sort();

  // 3. Remove index entries other organizations still hold for this site's
  //    (revoked) shares; live shares block deletion.
  for (const share of await store.listDocs<SiteShare>(paths.shares(orgId, site.id))) {
    const entryPath = paths.sharesWithOrgEntry(share.shared_with_org_id, share.id);
    const entry = await store.getDoc<SiteShare>(entryPath);
    if (entry && entry.site_id === site.id && entry.owner_org_id === orgId) await store.deleteDoc(entryPath);
  }

  // 4. Documents, leaf first.
  const tree = (await siteTree(orgId, site.id)) ?? [];
  const depth = sitePrefixLength(orgId, site.id);
  const rel = (item: string) => item.split('/').slice(depth);
  const versionDocs = tree.filter(item => { const r = rel(item); return r[0] === 'versions' && r.length === 2; })
    .sort((a, b) => Number(rel(a)[1] === 'main') - Number(rel(b)[1] === 'main'));
  const nested = tree.filter(item => { const r = rel(item); return r[0] !== 'versions' && r.length > 2; })
    .sort((a, b) => rel(b).length - rel(a).length || (a < b ? -1 : 1));
  const own = tree.filter(item => { const r = rel(item); return r[0] !== 'versions' && r.length === 2; });
  // Documents beneath a version that has no version document (orphans of an
  // earlier interruption or of old data) go with the nested ones.
  const versionSet = new Set(versionDocs);
  const orphans = tree.filter(item => { const r = rel(item); return r[0] === 'versions' && r.length > 2 && !versionSet.has(`${paths.site(orgId, site.id)}/versions/${r[1]}`); })
    .sort((a, b) => rel(b).length - rel(a).length || (a < b ? -1 : 1));

  // Each step removes a document and everything beneath it in one store call;
  // a version goes in one transaction with its pages, partials and revisions.
  const plan = [...versionDocs, ...orphans, ...nested, ...own];
  // No step lies beneath an earlier one: versions and the nested documents
  // outside them are disjoint, and nested documents go deepest first.
  for (const item of plan.slice(0, budget)) await store.deleteTree(item);
  const remaining = (await siteTree(orgId, site.id))?.length ?? 0;
  const deletedNow = tree.length - remaining;
  const total = audit.documents_total ?? inventory.documents.total;
  // Counted against the confirmed inventory, so a run that failed half way is accounted for too.
  audit.deleted_documents = Math.max(0, total - remaining - 1);
  audit.updated_at = new Date().toISOString();

  if (remaining > 0) {
    await writeAudit(orgId, auditId, audit);
    return {
      status: 202,
      body: {
        status: 'in_progress',
        site: site.id,
        organization_id: orgId,
        audit_id: auditId,
        deleted_documents: deletedNow,
        remaining_documents: remaining + 1,
        revoked_api_keys: audit.revoked_api_keys,
        message: 'Deletion is under way and not finished. Send the same request again to continue; the site cannot be restored.',
      },
    };
  }

  // 5. The site document last.
  await store.deleteDoc(sitePath);
  audit.deleted_documents = total;
  audit.status = 'succeeded';
  audit.finished_at = audit.updated_at = new Date().toISOString();
  await writeAudit(orgId, auditId, audit);
  return {
    status: 200,
    body: {
      status: 'deleted',
      site: site.id,
      organization_id: orgId,
      audit_id: auditId,
      deleted_documents: audit.deleted_documents,
      revoked_api_keys: audit.revoked_api_keys,
      untouched: inventory.untouched,
      also_removed: inventory.also_removed,
      message: `Site ${site.id} and its content have been permanently deleted. The resources listed in "untouched" are in your own accounts and were left as they are.`,
    },
  };
}
