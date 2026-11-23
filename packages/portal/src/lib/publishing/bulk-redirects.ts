// Exact redirect overflow stays static. Two account-wide lists stage immutable
// contents, then one owned rule switches them. Build engines never receive
// credentials for either operation.
import { randomUUID } from 'node:crypto';
import { pagesBulkRedirects, pagesRedirectsFile, type PagesPathRedirect } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';
import { cloudflarePermissionReport } from './cloudflare-capabilities';
import { digest, ProviderError, type ProviderClient } from './providers.mjs';
import { findPublishingZone } from './domain-provider';
import { mapPublicationParts } from './parallel';
import { createSafeFetch } from '../net/safe-fetch';

const PHASE = 'http_request_redirect';
type Slot = 'a' | 'b';
interface Item { comment: string; redirect: { source_url: string; target_url: string; status_code: number; include_subdomains: false; subpath_matching: false; preserve_path_suffix: false; preserve_query_string: false } }
interface Pending { job: string; publication: string; base: Slot | null; slot: Slot; hash: string; operation?: string; prepared?: boolean }
interface State { lease: string | null; until: number; pending?: Pending | null; owners?: Record<string, string> }
export interface BulkRedirectContext { org: string; account: string; site: string; version: string; host: string; publication: string; job: string }
const statePath = (org: string, account: string) => `organizations/${org}/publishing/bulk_redirects_${account}`;
const identity = (ctx: BulkRedirectContext) => `typeroll_redirects_${digest(ctx.org).slice(0, 16)}`;
const description = (ctx: BulkRedirectContext) => `Typeroll static redirect overflow: ${ctx.org}`;
const owner = (ctx: BulkRedirectContext) => `typeroll:${digest(JSON.stringify([ctx.org, ctx.site, ctx.version, ctx.host])).slice(0, 32)}`;
const owned = (ctx: BulkRedirectContext, item: Item) => item.comment.startsWith(owner(ctx) + ':');
const hashItems = (items: Item[]) => digest(JSON.stringify([...items].sort((a, b) => a.redirect.source_url.localeCompare(b.redirect.source_url))));

/** Cloudflare decodes unreserved source bytes and Unicode in API responses.
 * Keep reserved delimiters encoded: /encoded%2Fpath is not /encoded/path.
 */
function canonicalSourcePath(path: string): string {
  return path.replace(/%([a-f0-9]{2})/gi, (_encoded, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16));
    return /^[a-z0-9._~-]$/i.test(character) ? character : '%' + hex.toUpperCase();
  });
}

export interface BulkPlanReference { chunks: number; digest: string; count: number }
export async function saveBulkPlan(job: string, rules: PagesPathRedirect[]): Promise<BulkPlanReference> {
  const text = JSON.stringify(rules), chunks = Math.ceil(text.length / 120000);
  for (let index = 0; index < chunks; index++) await getStore().setDoc(`${job}/bulk_redirect_plan/${index}`, { data: text.slice(index * 120000, (index + 1) * 120000) });
  return { chunks, digest: digest(text), count: rules.length };
}
export async function readBulkPlan(job: string, reference?: BulkPlanReference): Promise<PagesPathRedirect[]> {
  if (!reference) return [];
  if (!Number.isInteger(reference.chunks) || reference.chunks < 1 || reference.chunks > 200) throw new Error('Invalid frozen Bulk Redirect plan');
  const parts = await mapPublicationParts(Array.from({ length: reference.chunks }, (_, index) => index), async index => {
    const part = await getStore().getDoc<{ data: string }>(`${job}/bulk_redirect_plan/${index}`);
    if (typeof part?.data !== 'string') throw new Error('Missing frozen Bulk Redirect plan');
    return part.data;
  });
  const text = parts.join('');
  if (digest(text) !== reference.digest) throw new Error('Frozen Bulk Redirect plan integrity mismatch');
  const rules = JSON.parse(text);
  if (!Array.isArray(rules) || rules.length !== reference.count) throw new Error('Invalid frozen Bulk Redirect count');
  return rules;
}

export function bulkRedirectItems(ctx: BulkRedirectContext, rules: PagesPathRedirect[]): Item[] {
  if (!rules.length) return [];
  if (!/^[a-z0-9.-]+$/.test(ctx.host) || ctx.host.endsWith('.pages.dev')) throw new ConnectionError('Bulk Redirects require a proxied website hostname in the connected hosting account.', 409, 'bulk_redirect_hostname_required');
  for (const rule of rules) {
    try {
      if (decodeURIComponent(new URL(rule.from_path, `https://${ctx.host}`).pathname) !== decodeURIComponent(rule.from_path)) throw new Error('normalized path differs');
    } catch { throw new ConnectionError('An overflow source contains an invalid encoding or dot segment. Correct that source without broadening its redirect coverage.', 409, 'bulk_redirect_source_invalid'); }
  }
  return rules.map(rule => ({ comment: `${owner(ctx)}:${digest(ctx.publication).slice(0, 16)}`, redirect: {
    source_url: ctx.host + canonicalSourcePath(new URL(rule.from_path, `https://${ctx.host}`).pathname),
    target_url: new URL(rule.to_path, `https://${ctx.host}`).href, status_code: rule.status_code,
    include_subdomains: false, subpath_matching: false, preserve_path_suffix: false, preserve_query_string: false,
  } }));
}

/** No provider mutation: fail before a costly build when consent or DNS is missing. */
export async function preflightBulkRedirects(org: string, group: string, account: string, host: string, provider: ProviderClient): Promise<void> {
  const report = await cloudflarePermissionReport(org, group);
  const capability = report.capabilities.find(item => item.capability === 'bulk_redirects')!;
  if (!['available', 'unknown'].includes(capability.status)) throw new ConnectionError(capability.next_step || 'Approve Bulk Redirect access in Publishing.', 409, 'bulk_redirect_permissions_required', { permission_update: report.permission_update, missing_scopes: capability.missing_scopes });
  if (host.endsWith('.pages.dev')) throw new ConnectionError('Choose a proxied website address in the hosting account to publish redirect overflow.', 409, 'bulk_redirect_hostname_required');
  const zone = await findPublishingZone(provider, account, host);
  const records = await provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
  if (!records.some((record: any) => record.name === host && record.proxied === true)) throw new ConnectionError('Bulk Redirects require the website DNS record to be proxied through Cloudflare in the hosting account. Prepare that address before publishing.', 409, 'bulk_redirect_hostname_required');
  await provider(`/accounts/${account}/rules/lists`);
  await provider(`/accounts/${account}/rulesets/phases/${PHASE}/entrypoint`, { missing: true });
}

/** Bind a receipt's overflow to the frozen rules, never to arbitrary build output. */
export function publicationBulkRedirects(text: string, frozen: any): PagesPathRedirect[] {
  const rules = pagesBulkRedirects(text);
  if (!rules.length) return rules;
  if (frozen.bulk_redirects_enabled !== true) throw new Error('Unexpected redirect overflow');
  const allowed = pagesRedirectsFile(frozen.redirects ?? [], frozen.settings, frozen.site, { bulkOverflow: true });
  const expanded = new Map<string, string>();
  for (const line of allowed.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [from, to, status] = line.split(/\s+/); expanded.set(from, `${to} ${status}`);
  }
  for (const rule of pagesBulkRedirects(allowed)) expanded.set(rule.from_path, `${rule.to_path} ${rule.status_code}`);
  for (const rule of rules) if (expanded.get(rule.from_path) !== `${rule.to_path} ${rule.status_code}`) throw new Error('Redirect overflow differs from the frozen publication');
  return rules;
}

async function listItems(provider: ProviderClient, root: string, list: any): Promise<Item[]> {
  if (!list) return [];
  const items: Item[] = [], cursors = new Set<string>(); let cursor = '';
  do {
    const page = await provider(`${root}/rules/lists/${list.id}/items?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { envelope: true });
    if (!Array.isArray(page?.result)) throw new Error('Invalid Bulk Redirect list response');
    for (const item of page.result) {
      const r = item.redirect;
      if (typeof item.comment !== 'string' || !/^typeroll:[a-f0-9]{32}:[a-f0-9]{16}$/.test(item.comment) || !r ||
        typeof r.source_url !== 'string' || typeof r.target_url !== 'string' || ![301, 302].includes(r.status_code) ||
        r.include_subdomains === true || r.subpath_matching === true || r.preserve_path_suffix === true || r.preserve_query_string === true) throw new ConnectionError('A managed Bulk Redirect list was edited outside Typeroll. Review it before publishing; customer rules are not overwritten.', 409, 'bulk_redirect_conflict');
      // Cloudflare returns Unicode paths decoded. Compare URL-normalized values
      // without decoding reserved delimiters such as %2F into a different path.
      if (!/^[a-z0-9.-]+(?:\/|$)/i.test(r.source_url)) throw new ConnectionError('The managed Bulk Redirect source changed format.', 409, 'bulk_redirect_conflict');
      const source = new URL('https://' + r.source_url), target = new URL(r.target_url);
      if (source.search || source.hash || source.username || source.password || source.port || !['https:', 'http:'].includes(target.protocol)) throw new ConnectionError('The managed Bulk Redirect URL changed format.', 409, 'bulk_redirect_conflict');
      items.push({ comment: item.comment, redirect: { source_url: source.host + canonicalSourcePath(source.pathname), target_url: target.href, status_code: r.status_code, include_subdomains: false, subpath_matching: false, preserve_path_suffix: false, preserve_query_string: false } });
    }
    cursor = page.result_info?.cursors?.after || '';
    if (cursor && cursors.has(cursor) || items.length > 50000) throw new Error('Invalid Bulk Redirect pagination');
    cursors.add(cursor);
  } while (cursor);
  if (items.length !== list.num_items) throw new ConnectionError('The Bulk Redirect list changed while it was being read. Retry publishing.', 409, 'bulk_redirect_conflict');
  return items;
}

/** Stage before Pages replaces the site; activate only after candidate verification.
 * Pending operations survive process loss. A different site waits for the same
 * account operation, so it cannot erase entries staged by its neighbour.
 */
export async function prepareBulkRedirects(ctx: BulkRedirectContext, rules: PagesPathRedirect[], provider: ProviderClient, activate = false, rollback?: { publication: string; before: PagesPathRedirect[] }): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(ctx.account) || !/^[a-zA-Z0-9_-]+$/.test(ctx.org)) throw new Error('Invalid Bulk Redirect account identity');
  const store = getStore(), stateKey = statePath(ctx.org, ctx.account), existing = await store.getDoc<State>(stateKey);
  if (!rules.length && !existing) return true;
  const items = bulkRedirectItems(ctx, rules), lease = randomUUID();
  await store.createDocIfMissing(stateKey, { lease: null, until: 0 });
  const locked = await store.compareAndUpdateDoc<State>(stateKey, state => state.until < Date.now(), { lease, until: Date.now() + 120000 });
  if (!locked) return false;
  let state = (await store.getDoc<State>(stateKey))!;
  const save = async (pending: Pending | null) => {
    if (!await store.compareAndUpdateDoc<State>(stateKey, current => current.lease === lease && current.until > Date.now(), { pending, until: Date.now() + 120000 })) throw new ConnectionError('Bulk Redirect ownership changed; retrying from its checkpoint.', 409, 'bulk_redirect_conflict');
    state = { ...state, pending };
  };
  const call: ProviderClient = async (route, options) => {
    if (!await store.compareAndUpdateDoc<State>(stateKey, current => current.lease === lease && current.until > Date.now(), { until: Date.now() + 120000 })) throw new ConnectionError('Bulk Redirect ownership changed.', 409, 'bulk_redirect_conflict');
    return provider(route, options);
  };
  const recordOwner = async () => {
    const owners = { ...state.owners, [owner(ctx)]: ctx.publication };
    if (!await store.compareAndUpdateDoc<State>(stateKey, current => current.lease === lease && current.until > Date.now(), { owners })) throw new ConnectionError('Bulk Redirect ownership changed.', 409, 'bulk_redirect_conflict');
    state.owners = owners;
  };
  try {
    const root = `/accounts/${ctx.account}`, name = identity(ctx), label = description(ctx);
    let lists = await call(`${root}/rules/lists`);
    let entry = await call(`${root}/rulesets/phases/${PHASE}/entrypoint`, { missing: true });
    let rule = entry?.rules?.find((r: any) => r.ref === name);
    const listFor = (slot: Slot) => lists.find((list: any) => list.name === `${name}_${slot}`);
    for (const slot of ['a', 'b'] as const) {
      const list = listFor(slot);
      if (list && (list.kind !== 'redirect' || list.description !== label)) throw new ConnectionError('A Bulk Redirect list name is already in use. Existing lists are not replaced.', 409, 'bulk_redirect_conflict');
    }
    const active: Slot | null = rule ? (['a', 'b'] as const).find(slot => rule.action_parameters?.from_list?.name === `${name}_${slot}`) ?? null : null;
    if (rule && (!active || rule.action !== 'redirect' || rule.enabled === false || rule.expression !== `http.request.full_uri in $${name}_${active}` || rule.action_parameters?.from_list?.key !== 'http.request.full_uri')) throw new ConnectionError('The managed Bulk Redirect rule was edited outside Typeroll.', 409, 'bulk_redirect_conflict');
    if (rollback && state.pending?.job === ctx.job && state.pending.publication !== ctx.publication) await save(null);
    if (state.pending && (state.pending.publication !== ctx.publication || state.pending.job !== ctx.job)) {
      const job = await store.getDoc<{ status: string }>(state.pending.job);
      if (job && ['queued', 'running'].includes(job.status)) return false;
      // A stopped publication can only have activated its already verified
      // candidate. Rebase the next operation on the provider's actual pointer.
      await save(null);
    }
    if (!state.pending) {
      const previous = await listItems(call, root, active ? listFor(active) : null);
      const previousOwned = previous.filter(item => owned(ctx, item));
      if (rollback) {
        // A newer publication on this hostname owns its own comment identity.
        // Restoring the old job must never replace that later publication.
        const expected = `${owner(ctx)}:${digest(rollback.publication).slice(0, 16)}`;
        const sameRedirects = (entries: Item[]) => JSON.stringify(entries.map(item => item.redirect).sort((a, b) => a.source_url.localeCompare(b.source_url)));
        if (sameRedirects(previousOwned) === sameRedirects(bulkRedirectItems(ctx, rollback.before))) return true;
        const recorded = state.owners?.[owner(ctx)];
        if (recorded && recorded !== rollback.publication && recorded !== ctx.publication && !previousOwned.some(item => item.comment === expected)) throw new ConnectionError('A newer publication owns these Bulk Redirects. They were not rolled back.', 409, 'bulk_redirect_rollback_conflict');
        if (previousOwned.length && previousOwned.some(item => item.comment !== expected && item.comment !== items[0]?.comment)) {
          throw new ConnectionError('A newer publication owns these Bulk Redirects. They were not rolled back.', 409, 'bulk_redirect_rollback_conflict');
        }
      } else {
        const journal = `${ctx.job}/bulk_redirect_rollback/state`;
        if (!await store.getDoc(journal)) {
          const before = previousOwned.map(item => ({ from_path: new URL('https://' + item.redirect.source_url).pathname, to_path: item.redirect.target_url, status_code: item.redirect.status_code as 301 | 302 }));
          await store.createDocIfMissing(journal, { plan: await saveBulkPlan(journal, before), restored: false });
        }
      }
      const desired = [...previous.filter(item => !owned(ctx, item)), ...items];
      if (hashItems(previous) === hashItems(desired)) { if (activate) await recordOwner(); return true; }
      const sources = desired.map(item => item.redirect.source_url);
      if (new Set(sources).size !== sources.length) throw new ConnectionError('Another published Site already owns an overflow source URL.', 409, 'bulk_redirect_conflict');
      const slot = active === 'a' ? 'b' : 'a';
      if (!listFor(slot)) {
        const created = await call(`${root}/rules/lists`, { method: 'POST', body: { name: `${name}_${slot}`, description: label, kind: 'redirect' } });
        lists = [...lists, created];
      }
      // Reconstruct desired content from the unchanged active list on retry;
      // the pending owner excludes any other Typeroll list modification.
      await save({ job: ctx.job, publication: ctx.publication, base: active, slot, hash: hashItems(desired) });
    }
    const pending = state.pending!;
    const target = listFor(pending.slot);
    if (!target) throw new Error('Staged Bulk Redirect list is missing');
    if (active !== pending.base && active !== pending.slot) throw new ConnectionError('The active Bulk Redirect list changed outside this publication.', 409, 'bulk_redirect_conflict');
    if (!pending.prepared) {
      if (pending.operation) {
        const operation = await call(`${root}/rules/lists/bulk_operations/${pending.operation}`);
        if (operation.status === 'pending' || operation.status === 'running') return false;
        if (operation.status !== 'completed') throw new ConnectionError('Cloudflare could not prepare the Bulk Redirect list. Check the account URL quota and list status; the previous list remains active.', 409, 'bulk_redirect_prepare_failed');
      }
      const current = await listItems(call, root, target);
      if (hashItems(current) !== pending.hash) {
        if (pending.operation) throw new ConnectionError('Cloudflare returned different staged Bulk Redirect contents.', 409, 'bulk_redirect_conflict');
        const previous = await listItems(call, root, pending.base ? listFor(pending.base) : null);
        const desired = [...previous.filter(item => !owned(ctx, item)), ...items];
        if (hashItems(desired) !== pending.hash) throw new ConnectionError('The frozen Bulk Redirect plan changed.', 409, 'bulk_redirect_conflict');
        const operation = await call(`${root}/rules/lists/${target.id}/items`, { method: 'PUT', body: desired });
        if (!/^[a-f0-9]{32}$/.test(operation?.operation_id ?? '')) throw new Error('Missing Bulk Redirect operation identity');
        await save({ ...pending, operation: operation.operation_id });
        return false;
      }
      await save({ ...pending, prepared: true });
    }
    if (!activate) return true;
    if (hashItems(await listItems(call, root, target)) !== pending.hash) throw new ConnectionError('The staged Bulk Redirect list changed before activation. Existing traffic was retained.', 409, 'bulk_redirect_conflict');
    // Re-read immediately before the pointer update, and only patch our own
    // rule. Never PUT an entire entry point containing customer rules.
    entry = await call(`${root}/rulesets/phases/${PHASE}/entrypoint`, { missing: true });
    rule = entry?.rules?.find((r: any) => r.ref === name);
    const body = { ref: name, description: label, action: 'redirect', enabled: true,
      expression: `http.request.full_uri in $${target.name}`,
      action_parameters: { from_list: { name: target.name, key: 'http.request.full_uri' } } };
    if (!rule || rule.action_parameters?.from_list?.name !== target.name) {
      if (rule && rule.action_parameters?.from_list?.name !== `${name}_${pending.base}`) throw new ConnectionError('The Bulk Redirect rule changed before activation.', 409, 'bulk_redirect_conflict');
      if (!entry) await call(`${root}/rulesets`, { method: 'POST', body: { name: 'Typeroll static redirect overflow', kind: 'root', phase: PHASE, rules: [body] } });
      else await call(`${root}/rulesets/${entry.id}/rules${rule ? `/${rule.id}` : ''}`, { method: rule ? 'PATCH' : 'POST', body });
    }
    const confirmed = await call(`${root}/rulesets/phases/${PHASE}/entrypoint`);
    const actual = confirmed.rules?.find((r: any) => r.ref === name);
    if (actual?.enabled !== true || actual?.expression !== body.expression || actual?.action_parameters?.from_list?.name !== target.name) return false;
    await recordOwner();
    await save(null);
    return true;
  } catch (error) {
    // Lists allows one asynchronous item mutation at a time. A lost response
    // can leave that mutation running without a saved operation id. Waiting
    // is a normal checkpoint, not five failed coordinator attempts.
    if (error instanceof ProviderError && error.status === 429) return false;
    if (error instanceof ProviderError && [400, 403].includes(error.status)) throw new ConnectionError('Cloudflare refused static redirect overflow. The connection needs Account Filter Lists and Bulk URL Redirects edit access, free list/rule slots and enough account-wide URL quota for the active and staged lists. Existing customer rules are retained.', 409, 'bulk_redirect_capacity_or_access', { provider_codes: error.codes });
    throw error;
  } finally {
    await store.compareAndUpdateDoc<State>(stateKey, current => current.lease === lease, { lease: null, until: 0 });
  }
}

/** A parked domain candidate must not reserve the organization-wide staging
 * list while an owner considers approval. The frozen job plan can be staged
 * again against the latest active list immediately before switching traffic.
 */
export async function releaseStagedBulkRedirects(ctx: BulkRedirectContext): Promise<boolean> {
  const store = getStore(), key = statePath(ctx.org, ctx.account);
  const state = await store.getDoc<State>(key);
  if (!state?.pending || state.pending.job !== ctx.job || state.pending.publication !== ctx.publication) return true;
  if (!state.pending.prepared) return false;
  return Boolean(await store.compareAndUpdateDoc<State>(key, current => current.until < Date.now() &&
    current.pending?.job === ctx.job && current.pending.publication === ctx.publication && current.pending.prepared === true,
    { pending: null }));
}

/** Restore only this publication's sources after its DNS rollback. Other
 * sites and later publications retain their active mappings.
 */
export async function rollbackBulkRedirects(ctx: BulkRedirectContext, provider: ProviderClient): Promise<boolean> {
  const key = `${ctx.job}/bulk_redirect_rollback/state`;
  const journal = await getStore().getDoc<{ plan: BulkPlanReference; restored: boolean }>(key);
  if (!journal || journal.restored) return true;
  const before = await readBulkPlan(key, journal.plan);
  const ready = await prepareBulkRedirects({ ...ctx, publication: ctx.publication + ':rollback' }, before, provider, true, { publication: ctx.publication, before });
  if (ready) await getStore().updateDoc(key, { restored: true });
  return ready;
}

/** One bounded part of publication verification, not a recurring site monitor. */
export async function verifyBulkRedirects(ctx: BulkRedirectContext, rules: PagesPathRedirect[], fetchImpl = createSafeFetch({ label: 'Published redirect', maxRedirects: 0, timeoutMs: 10000, maxBytes: 1024 })): Promise<boolean> {
  const store = getStore(), key = `${ctx.job}/bulk_redirect_checks/progress`, hash = digest(JSON.stringify(rules));
  const saved = await store.getDoc<{ hash: string; cursor: number }>(key);
  const cursor = saved?.hash === hash ? saved.cursor : 0;
  const batch = rules.slice(cursor, cursor + 10);
  const results = await mapPublicationParts(batch, async rule => {
    try {
      const response = await fetchImpl(`https://${ctx.host}${rule.from_path}`, { method: 'GET', redirect: 'manual' });
      await response.body?.cancel();
      return response.status === rule.status_code && new URL(response.headers.get('location') || '', `https://${ctx.host}${rule.from_path}`).href === new URL(rule.to_path, `https://${ctx.host}`).href;
    } catch { return false; }
  }, 5);
  if (results.some(result => !result)) return false;
  await store.setDoc(key, { hash, cursor: cursor + batch.length });
  return cursor + batch.length === rules.length;
}
