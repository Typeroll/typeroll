import { beforeEach, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { bulkRedirectItems, prepareBulkRedirects, rollbackBulkRedirects, publicationBulkRedirects, saveBulkPlan, readBulkPlan, verifyBulkRedirects, releaseStagedBulkRedirects, type BulkRedirectContext } from '../../lib/publishing/bulk-redirects';
import { pagesRedirectsFile } from '@typeroll/shared';
import { ProviderError, type ProviderClient } from '../../lib/publishing/providers.mjs';

const ctx: BulkRedirectContext = { org: 'org', account: 'a'.repeat(32), site: 'one', version: 'main', host: 'www.example.test', publication: 'p1', job: 'organizations/org/sites/one/deploys/job1' };
const rules = [{ from_path: '/old/', to_path: '/new/?fixed=1#part', status_code: 302 as const }];
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

function provider() {
  const state = { lists: [] as any[], rules: [] as any[], items: {} as Record<string, any[]>, operations: {} as Record<string, any>, writes: [] as string[], next: 1, pending: false, reject: false, uncertain: false, pageSize: 1000 };
  const client: ProviderClient = async (route, options = {}) => {
    const root = `/accounts/${ctx.account}`;
    if (!route.startsWith(root)) throw Error('Wrong account');
    const local = route.slice(root.length), method = options.method ?? 'GET', body = options.body as any;
    if (method !== 'GET') { state.writes.push(method + ' ' + local); if (state.reject) throw new ProviderError('Cloudflare', 400); }
    if (local === '/rules/lists') {
      if (method === 'GET') return state.lists.map(list => ({ ...list, num_items: (state.items[list.id] ?? []).length }));
      const list = { ...body, id: `l${state.next++}`, num_items: 0 }; state.lists.push(list); return list;
    }
    if (local.includes('/bulk_operations/')) return state.operations[local.split('/').pop()!];
    if (local.includes('/items')) {
      const id = local.split('/')[3];
      if (method === 'PUT') {
        const operation = (state.next++).toString(16).padStart(32, '0');
        state.items[id] = structuredClone(body);
        state.operations[operation] = { status: state.pending ? 'pending' : 'completed' };
        if (state.uncertain) { state.uncertain = false; throw Error('connection lost after successful write'); }
        return { operation_id: operation };
      }
      const start = Number(new URL('https://api.test' + local).searchParams.get('cursor')) || 0;
      const all = state.items[id] ?? [], page = all.slice(start, start + state.pageSize);
      return { result: page, result_info: { cursors: { after: start + page.length < all.length ? String(start + page.length) : '' } } };
    }
    if (local.endsWith('/entrypoint')) return state.rules.length ? { id: 'entry', rules: structuredClone(state.rules) } : null;
    if (local === '/rulesets' && method === 'POST') { state.rules.push(...body.rules.map((rule: any) => ({ ...rule, id: 'owned' }))); return {}; }
    if (local.includes('/rulesets/entry/rules')) {
      if (method === 'POST') state.rules.push({ ...body, id: 'owned' });
      else state.rules = state.rules.map(rule => rule.id === local.split('/').pop() ? { ...body, id: rule.id } : rule);
      return {};
    }
    throw Error('Unexpected provider call: ' + method + ' ' + local);
  };
  return { state, client };
}
async function finish(p: ReturnType<typeof provider>, context = ctx, redirects = rules, activate = true) {
  for (let i = 0; i < 6; i++) if (await prepareBulkRedirects(context, redirects, p.client, activate)) return;
  throw Error('did not finish');
}
it('stages before activation and keeps exact status, target, host and query behavior', async () => {
  const p = provider();
  await finish(p, ctx, rules, false);
  expect(p.state.rules).toHaveLength(0);
  const items = Object.values(p.state.items).flat();
  expect(items[0].redirect).toEqual({ source_url: 'www.example.test/old/', target_url: 'https://www.example.test/new/?fixed=1#part', status_code: 302,
    include_subdomains: false, subpath_matching: false, preserve_path_suffix: false, preserve_query_string: false });
  await finish(p);
  expect(p.state.rules).toHaveLength(1);
  expect(p.state.rules[0].expression).toContain(' in $typeroll_redirects_');
  expect(() => bulkRedirectItems({ ...ctx, host: 'x.pages.dev' }, rules)).toThrow('proxied');
  expect(bulkRedirectItems(ctx, [{ ...rules[0]!, from_path: '/åäö/%2F/' }])[0]!.redirect.source_url).toBe('www.example.test/%C3%A5%C3%A4%C3%B6/%2F/');
  expect(() => bulkRedirectItems(ctx, [{ ...rules[0]!, from_path: '/old/%2e%2e/live' }])).toThrow('dot segment');
});
it('preserves another site and foreign account rules through a shared-list switch', async () => {
  const p = provider();
  p.state.rules.push({ id: 'foreign', ref: 'customer', action: 'redirect', expression: 'customer rule' });
  await finish(p);
  const other = { ...ctx, site: 'two', host: 'second.example.test', publication: 'p2', job: 'organizations/org/sites/two/deploys/job2' };
  p.state.pageSize = 1;
  await finish(p, other);
  expect(p.state.rules.find(r => r.id === 'foreign').expression).toBe('customer rule');
  const active = p.state.rules.find(r => r.ref !== 'customer').action_parameters.from_list.name;
  const id = p.state.lists.find(l => l.name === active).id;
  expect(p.state.items[id].map(i => i.redirect.source_url).sort()).toEqual(['second.example.test/old/', 'www.example.test/old/']);
  expect(p.state.lists).toHaveLength(2);
  const writes = p.state.writes.length;
  await finish(p, other);
  expect(p.state.writes).toHaveLength(writes);
});
it('recovers a lost write response without activating partial contents', async () => {
  const p = provider(); p.state.uncertain = true;
  await expect(prepareBulkRedirects(ctx, rules, p.client)).rejects.toThrow('connection lost');
  expect(p.state.rules).toHaveLength(0);
  await finish(p);
  expect(p.state.writes.filter(w => w.startsWith('PUT'))).toHaveLength(1);
});
it('waits for asynchronous completion and serializes different publications', async () => {
  const p = provider(); p.state.pending = true;
  await getStore().setDoc(ctx.job, { status: 'running' });
  expect(await prepareBulkRedirects(ctx, rules, p.client)).toBe(false);
  expect(await prepareBulkRedirects(ctx, rules, p.client)).toBe(false);
  const other = { ...ctx, publication: 'p2', site: 'two', job: 'organizations/org/sites/two/deploys/job2' };
  expect(await prepareBulkRedirects(other, rules, p.client)).toBe(false);
  expect(p.state.rules).toHaveLength(0);
  Object.values(p.state.operations).forEach(o => { o.status = 'completed'; });
  await finish(p);
});
it('refuses a failed operation, quota errors and externally edited managed lists', async () => {
  const p = provider();
  await prepareBulkRedirects(ctx, rules, p.client);
  Object.values(p.state.operations).forEach(o => { o.status = 'failed'; });
  await expect(prepareBulkRedirects(ctx, rules, p.client)).rejects.toThrow('could not prepare');
  expect(p.state.rules).toHaveLength(0);
  const q = provider(); q.state.reject = true;
  await expect(prepareBulkRedirects({ ...ctx, org: 'another' }, rules, q.client)).rejects.toThrow('URL quota');
});
it('clears only this site from the active list when its rules fit Pages again', async () => {
  const p = provider(); await finish(p);
  await finish(p, { ...ctx, publication: 'p2' }, []);
  const active = p.state.rules[0].action_parameters.from_list.name;
  expect(p.state.items[p.state.lists.find(l => l.name === active).id] ?? []).toEqual([]);
});
it('rolls back only the affected hostname while preserving another Site', async () => {
  const p = provider(); await finish(p);
  const changed = { ...ctx, publication: 'changed', job: ctx.job + '-changed' };
  await finish(p, changed, [{ ...rules[0]!, to_path: '/changed/' }]);
  const other = { ...ctx, site: 'other', host: 'other.example.test', publication: 'other', job: ctx.job + '-other' };
  await finish(p, other);
  for (let i = 0; i < 5; i++) if (await rollbackBulkRedirects(changed, p.client)) break;
  const active = p.state.rules[0].action_parameters.from_list.name;
  const items = p.state.items[p.state.lists.find(l => l.name === active).id];
  expect(items.find((i: any) => i.redirect.source_url.startsWith(ctx.host)).redirect.target_url).toBe('https://www.example.test/new/?fixed=1#part');
  expect(items.some((i: any) => i.redirect.source_url.startsWith(other.host))).toBe(true);
});
it('does not restore an old job over a later publication that removed all its overflow', async () => {
  const p = provider(); await finish(p);
  const changed = { ...ctx, publication: 'changed', job: ctx.job + '-changed' };
  await finish(p, changed, [{ ...rules[0]!, to_path: '/changed/' }]);
  await finish(p, { ...ctx, publication: 'latest', job: ctx.job + '-latest' }, []);
  await expect(rollbackBulkRedirects(changed, p.client)).rejects.toMatchObject({ code: 'bulk_redirect_rollback_conflict' });
});
it('binds receipt plans to frozen rules and rejects changed targets', async () => {
  const redirects = Array.from({ length: 2010 }, (_, i) => ({ from_path: `/old-${i}.html`, to_path: '/new/', status_code: 301 as const }));
  const frozen = { redirects, bulk_redirects_enabled: true };
  const text = pagesRedirectsFile(redirects, {}, {}, { bulkOverflow: true });
  expect(publicationBulkRedirects(text, frozen)).toHaveLength(10);
  expect(() => publicationBulkRedirects(text.replaceAll('/new/', '/changed/'), frozen)).toThrow('frozen');
  const reference = await saveBulkPlan(ctx.job, publicationBulkRedirects(text, frozen));
  expect(await readBulkPlan(ctx.job, reference)).toHaveLength(10);
  await getStore().setDoc(ctx.job + '/bulk_redirect_plan/0', { data: '[]' });
  await expect(readBulkPlan(ctx.job, reference)).rejects.toThrow('integrity');
});
it('verifies real redirect statuses and destinations in bounded publication batches', async () => {
  const redirects = Array.from({ length: 12 }, (_, i) => ({ from_path: `/old-${i}`, to_path: '/new/#part', status_code: 301 as const }));
  const edge = async () => new Response(null, { status: 301, headers: { location: 'https://www.example.test/new/#part' } });
  expect(await verifyBulkRedirects(ctx, redirects, edge)).toBe(false);
  expect(await verifyBulkRedirects(ctx, redirects, edge)).toBe(true);
  expect(await verifyBulkRedirects({ ...ctx, job: ctx.job + 'other' }, redirects, async () => new Response(null, { status: 302, headers: { location: '/new/#part' } }))).toBe(false);
});

it('releases a parked candidate and rebases it on sites published during approval', async () => {
  const p = provider();
  await getStore().setDoc(ctx.job, { status: 'running' });
  await finish(p, ctx, rules, false);
  expect(await releaseStagedBulkRedirects(ctx)).toBe(true);
  const other = { ...ctx, site: 'two', host: 'second.example.test', publication: 'p2', job: 'organizations/org/sites/two/deploys/job2' };
  await finish(p, other);
  await finish(p, ctx, rules, false);
  await finish(p);
  const active = p.state.rules[0].action_parameters.from_list.name;
  const id = p.state.lists.find(l => l.name === active).id;
  expect(p.state.items[id].map(i => i.redirect.source_url).sort()).toEqual(['second.example.test/old/', 'www.example.test/old/']);
  expect(bulkRedirectItems({ ...ctx, host: 'x.pages.dev' }, [])).toEqual([]);
});
