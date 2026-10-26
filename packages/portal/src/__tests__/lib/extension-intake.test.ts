import { describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { paths, type Form } from '@typeroll/shared';
import type { ReadWriteStore } from '../../lib/datastore';
import { extensionIntake, intakeSnapshot, visibleIntake } from '../../lib/forms/extension-intake';
const form: Form = { id: 'survey', name: 'Private questions', created_at: 'test', actions: [], target: { installation_id: 'installed', path: '/follow-up' }, steps: [
  { id: 'interest', title: 'Your plans', blocks: [{ id: 'pilot', type: 'form/boolean', data: { name: 'pilot', label: 'Pilot interest', required: true } }] },
  { id: 'features', title: 'What would help?', blocks: [{ id: 'feature', type: 'form/checkbox_group', data: { name: 'features', label: 'Features', choices: [{ value: 'reporting', label: 'Reporting' }, { value: 'orders', label: 'Orders' }] } }] },
  { id: 'support', title: 'Support', blocks: [{ id: 'need', type: 'form/text', data: { name: 'need', label: 'Support needs' } }] },
] };
const conditions = { features: { source: 'answers', field: 'pilot', equals: true }, support: { source: 'context', field: 'support', equals: false } };
const input = { action: 'describe', subject_id: 'a'.repeat(64), context: { support: false }, conditions, reference: { page_id: 'synthetic', proposal_id: 'p1' }, answers: {} };
function setup() {
  const rows = new Map<string, any>([[`${paths.forms('o', 's')}/survey`, form]]);
  const store = {
    getDoc: async (path: string) => rows.get(path) ?? null,
    createDocIfMissing: async (path: string, value: any) => { if (rows.has(path)) return false; rows.set(path, structuredClone(value)); return true; },
    compareAndReplaceDoc: async (path: string, expected: any, value: any) => { if (!isDeepStrictEqual(rows.get(path), expected)) return false; rows.set(path, structuredClone(value)); return true; },
    compareAndUpdateDoc: async (path: string, check: (value: any) => boolean, patch: any) => { const value = rows.get(path); if (!value || !check(value)) return null; const updated = { ...value, ...patch }; rows.set(path, updated); return updated; },
  } as unknown as ReadWriteStore;
  return { rows, store, call: (body = input, install = 'installed') => extensionIntake(store, 'o', 's', install, 'survey', body) };
}
describe('installation-authorized private form intake', () => {
  it('uses server context and prior visible answers; removes stale hidden answers', () => {
    const snapshot = intakeSnapshot(form, { support: false }, conditions, {});
    expect(visibleIntake(snapshot, { pilot: true, features: ['orders'], need: 'Help' }, true).data).toEqual({ pilot: true, features: ['orders'], need: 'Help' });
    expect(visibleIntake(snapshot, { pilot: false, features: ['orders'], need: 'Help' }, true).data).toEqual({ pilot: false, need: 'Help' });
  });
  it('never treats an answer from a hidden step as trusted input for a later condition', () => {
    const third = { ...conditions, support: { source: 'answers', field: 'features', includes: 'orders' } };
    const snapshot = intakeSnapshot(form, { support: false }, third, {});
    expect(visibleIntake(snapshot, { pilot: false, features: ['orders'], need: 'Leaked' }, true).data).toEqual({ pilot: false });
  });
  it('keeps false and null distinct and validates required and enum answers', () => {
    const snapshot = intakeSnapshot(form, {}, {}, {});
    expect(visibleIntake(snapshot, { pilot: false }, true).data).toEqual({ pilot: false });
    expect(() => visibleIntake(snapshot, { pilot: null }, true)).toThrow();
    expect(() => visibleIntake(snapshot, { pilot: true, features: ['unknown'] }, true)).toThrow('Features');
    expect(() => visibleIntake(snapshot, { pilot: 'false' }, true)).toThrow('Pilot interest');
  });
  it('rejects unknown fields, forward references, dangerous keys and action-bearing forms', () => {
    expect(() => intakeSnapshot(form, {}, { interest: { source: 'answers', field: 'features', includes: 'orders' } }, {})).toThrow('earlier');
    expect(() => intakeSnapshot(form, {}, { unknown: { source: 'context', field: 'support', equals: false } }, {})).toThrow();
    expect(() => intakeSnapshot({ ...form, actions: [{ type: 'email', config: {} }] }, {}, {}, {})).toThrow('remove actions');
    expect(() => visibleIntake(intakeSnapshot(form, {}, {}, {}), JSON.parse('{"__proto__":1}'), false)).toThrow('unknown');
  });
  it('requires the exact installation and a start before submission', async () => {
    const ctx = setup();
    await expect(ctx.call(input, 'other')).rejects.toMatchObject({ status: 404 });
    await expect(ctx.call({ ...input, action: 'complete' })).rejects.toMatchObject({ status: 409 });
  });
  it('pins the form snapshot, binds context and persists only private answers once', async () => {
    const ctx = setup(); const start = await ctx.call();
    expect(start).toHaveProperty('revision');
    const revision = (start as any).revision;
    ctx.rows.set(`${paths.forms('o', 's')}/survey`, { ...form, steps: [] });
    const complete = { ...input, action: 'complete', revision, answers: { pilot: false, features: ['orders'], need: 'Help' } };
    const results = await Promise.all([ctx.call(complete), ctx.call(complete)]);
    expect(results[0]).toEqual(results[1]);
    const submissions = [...ctx.rows.entries()].filter(([path]) => path.startsWith(paths.submissions('o', 's')));
    expect(submissions).toHaveLength(1);
    expect(submissions[0]![1]).toMatchObject({ status: 'complete', data: { pilot: false, need: 'Help' }, intake: { context: { support: false }, reference: { proposal_id: 'p1' } } });
    expect(submissions[0]![1].data).not.toHaveProperty('features');
    await expect(ctx.call({ ...complete, answers: { pilot: true } })).rejects.toMatchObject({ status: 409 });
    await expect(ctx.call({ ...input, context: { support: true } })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects stale revisions without creating a completed response', async () => {
    const ctx = setup(); await ctx.call();
    await expect(ctx.call({ ...input, action: 'complete', revision: 'stale', answers: { pilot: true } } as any)).rejects.toMatchObject({ status: 409 });
    expect([...ctx.rows.values()].filter(row => row.status === 'complete')).toHaveLength(0);
  });
});

it('maps only the authorized intake method to the installation execute scope', async () => {
  const { extensionScopeForApiRequest } = await import('../../lib/api-auth');
  expect(extensionScopeForApiRequest('/api/v1/sites/site/forms/survey/intake', 'POST')).toBe('forms:execute');
  expect(extensionScopeForApiRequest('/api/v1/sites/site/forms/survey/intake', 'GET')).not.toBe('forms:execute');
});

it('refuses an expired partial interview even before retention has removed it', async () => {
  const ctx = setup(); await ctx.call();
  for (const [path, record] of ctx.rows) if (path.startsWith(paths.submissions('o', 's'))) record.expires_at = '2000-01-01T00:00:00Z';
  await expect(ctx.call()).rejects.toMatchObject({ status: 409 });
});


describe('durable private intake saves', () => {
  it('restores partial answers and preserves false without a partial-expiry deadline', async () => {
    const ctx = setup(), start = await ctx.call();
    const saved = await ctx.call({ ...input, action: 'save', revision: start.revision, request_id: 'save-first-answer-0001', answers: { pilot: false } } as any);
    expect(saved.answers).toEqual({ pilot: false }); expect(saved.revision).not.toBe(start.revision);
    const { answers: ignored, ...describe } = input;
    expect(await ctx.call(describe as any)).toMatchObject({ answers: { pilot: false }, revision: saved.revision });
    expect([...ctx.rows.values()].find(row => row.status === 'partial')).toMatchObject({ expires_at: null });
  });
  it('rejects stale writes, deduplicates the same request and rejects changed reuse', async () => {
    const ctx = setup(), start = await ctx.call();
    const save = { ...input, action: 'save', revision: start.revision, request_id: 'save-first-answer-0001', answers: { pilot: true, features: ['orders'] } };
    const results = await Promise.all([ctx.call(save as any), ctx.call(save as any)]);
    expect(results[0]).toEqual(results[1]);
    await expect(ctx.call({ ...save, answers: { pilot: false } } as any)).rejects.toMatchObject({ status: 409 });
    await expect(ctx.call({ ...save, request_id: 'save-stale-answer-0002' } as any)).rejects.toMatchObject({ status: 409 });
    const cleared = await ctx.call({ ...save, revision: results[0]!.revision, request_id: 'save-clear-answer-0003', answers: { pilot: null, features: ['orders'] } } as any);
    expect(cleared.answers).toEqual({ pilot: null });
    const { answers: ignored, ...describe } = input;
    expect((await ctx.call(describe as any)).answers).not.toHaveProperty('features');
  });
  it('commits notification milestones with answers and does not expose private recipients', async () => {
    const ctx = setup(), notify = vi.fn(async () => {});
    const body = { ...input, notifications: { recipient: 'admin@example.invalid', first_answer_field: 'pilot' } };
    const call = (value: any) => extensionIntake(ctx.store, 'o', 's', 'installed', 'survey', value, { notify });
    const start = await call(body);
    const save = { ...body, action: 'save', revision: start.revision, request_id: 'first-interest-save-0001', answers: { pilot: false } };
    const saved = await call(save);
    let row = [...ctx.rows.values()].find(row => row.status === 'partial');
    expect(row.notifications.first_answer).toMatchObject({ status: 'pending', attempts: 0 });
    expect(row.notifications.first_answer.text).toContain('No');
    expect(JSON.stringify(saved)).not.toContain('admin@example.invalid');
    await call({ ...body, action: 'complete', revision: saved.revision, request_id: 'complete-intake-0001', answers: { pilot: false, need: 'Please help' } });
    row = [...ctx.rows.values()].find(row => row.status === 'complete');
    expect(Object.keys(row.notifications)).toEqual(['first_answer', 'complete']);
    expect(row.notifications.complete.text).toContain('Please help');
  });
  it('does not queue a second message for unchanged completion', async () => {
    const ctx = setup(), notify = vi.fn(async () => {}), body = { ...input, notifications: { recipient: 'admin@example.invalid', first_answer_field: 'pilot' } };
    const call = (value: any) => extensionIntake(ctx.store, 'o', 's', 'installed', 'survey', value, { notify });
    const start = await call(body), saved = await call({ ...body, action: 'save', revision: start.revision, request_id: 'first-interest-save-0001', answers: { pilot: false } });
    await call({ ...body, action: 'complete', revision: saved.revision, request_id: 'complete-intake-0001', answers: { pilot: false } });
    expect(Object.keys([...ctx.rows.values()].find(row => row.status === 'complete').notifications)).toEqual(['first_answer']);
  });
});

it('withholds completed research answers from the owner session and retry response', async () => {
  const ctx = setup(), start = await ctx.call();
  const body = { ...input, action: 'complete', revision: start.revision, request_id: 'complete-private-0001', answers: { pilot: true, need: 'Private research' } };
  const first = await ctx.call(body as any), retry = await ctx.call(body as any);
  const { answers: ignored, ...describe } = input;
  for (const result of [first, retry, await ctx.call(describe as any)]) {
    expect(result.done).toBe(true); expect(result).not.toHaveProperty('answers'); expect(result).not.toHaveProperty('steps');
    expect(JSON.stringify(result)).not.toContain('Private research');
  }
});


it.each([{}, { pilot: null, need: '' }, { pilot: null, need: '   ' }])('does not notify for an unanswered optional completion: %j', async answers => {
  const ctx = setup(), optional = structuredClone(form);
  (optional.steps![0]!.blocks![0]!.data as any).required = false;
  ctx.rows.set(`${paths.forms('o', 's')}/survey`, optional);
  const body = { ...input, reference: { page_id: 'synthetic', page_title: 'Synthetic Company' }, notifications: { recipient: 'admin@example.invalid', first_answer_field: 'pilot' } };
  const call = (value: any) => extensionIntake(ctx.store, 'o', 's', 'installed', 'survey', value, { notify: vi.fn(async () => {}) });
  const start = await call(body);
  await call({ ...body, action: 'complete', revision: start.revision, request_id: 'empty-completion-0001', answers });
  expect([...ctx.rows.values()].find(row => row.status === 'complete').notifications).toEqual({});
});

it('keeps saved answers when notification transport fails and includes trusted profile name', async () => {
  const ctx = setup(), body = { ...input, reference: { page_id: 'synthetic', page_title: 'Synthetic Company' }, notifications: { recipient: 'admin@example.invalid', first_answer_field: 'pilot' } };
  const call = (value: any) => extensionIntake(ctx.store, 'o', 's', 'installed', 'survey', value, { notify: vi.fn(async () => { throw Error('Offline'); }) });
  const start = await call(body);
  expect(await call({ ...body, action: 'save', revision: start.revision, request_id: 'notify-offline-0001', answers: { pilot: false } })).toMatchObject({ answers: { pilot: false } });
  const row = [...ctx.rows.values()].find(row => row.status === 'partial');
  expect(row.notifications.first_answer.text).toContain('Profile: Synthetic Company');
  expect(row.notifications.first_answer.text).toContain('Page ID: synthetic');
  expect(row.notifications.first_answer.status).toBe('pending');
});
