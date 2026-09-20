import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, type ContentType, type Page } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { promoteBranch } from '../../lib/version-promote';

const ORG = 'promotion-test', SITE = 'directory', BRANCH = 'research';
const schema = {
  id: 'company', name: 'company', fields: [
    { name: 'support', type: 'object', label: 'Support', writable_by: ['portal', 'owner', 'agent', 'import'], fields: [
      { name: 'training', type: 'boolean', label: 'Training?' },
      { name: 'catalog', type: 'boolean', label: 'Catalog?' },
    ] },
  ],
} as ContentType;
const pagePath = paths.page(ORG, SITE, 'company');
const read = (version = 'main') => vstore.page(ORG, SITE, version, 'company') as Promise<Page>;
const write = (version: string, training: boolean | null, actor: 'agent' | 'owner' | 'portal' | 'import' = 'agent') =>
  vstore.writePage(ORG, SITE, version, 'company', { fields: { support: { training } } }, {
    actor, actorId: `synthetic-${actor}`, sources: { 'support/training': { source_url: 'https://example.com/research', import_run_id: 'research-1' } },
  });

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  const store = getStore();
  await store.setDoc(paths.version(ORG, SITE, BRANCH), { kind: 'branch', base_version_id: 'main' });
  await store.setDoc(paths.contentType(ORG, SITE, 'company'), schema as unknown as Record<string, unknown>);
  await store.setDoc(pagePath, { title: 'Company', slug: 'company', content_type: 'company', status: 'published', fields: {} });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('persisted answer authority across branch promotion', () => {
  it('preserves research evidence and permits a later owner correction after a real promotion', async () => {
    await write(BRANCH, true);
    const original = (await read(BRANCH))._provenance;
    await promoteBranch(ORG, SITE, BRANCH, 'main', 'synthetic-promoter');
    expect((await read())._provenance).toEqual(original);
    await expect(write('main', false, 'owner')).resolves.toBeUndefined();
    expect((await read()).fields?.support).toEqual({ training: false });
    await expect(write('main', true, 'import')).rejects.toThrow('higher-precedence');
  });

  it('preserves provenance for newly introduced schema fields and new pages', async () => {
    await getStore().setDoc(paths.contentType(ORG, SITE, 'company', BRANCH), schema as unknown as Record<string, unknown>);
    await getStore().setDoc(paths.contentType(ORG, SITE, 'company'), { ...schema, fields: [] } as unknown as Record<string, unknown>);
    await write(BRANCH, false);
    await vstore.writePage(ORG, SITE, BRANCH, 'new-company', {
      title: 'New company', slug: 'new-company', content_type: 'company', status: 'published', fields: { support: { catalog: true } },
    }, { actor: 'agent', actorId: 'synthetic-research', sources: { 'support/catalog': { source_url: 'https://example.com/catalog' } } });
    const original = (await vstore.page(ORG, SITE, BRANCH, 'new-company'))!;
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await vstore.page(ORG, SITE, 'main', 'new-company'))?._provenance).toEqual(original._provenance);
    expect((await read())._provenance?.['support/training'].source).toBe('agent');
    await expect(write('main', true, 'owner')).resolves.toBeUndefined();
  });

  it('uses the guarded source schema when the persisted branch changes content type', async () => {
    await getStore().setDoc(paths.contentType(ORG, SITE, 'updated-company', BRANCH), { ...schema, id: 'updated-company', name: 'updated-company' });
    await getStore().setDoc(paths.page(ORG, SITE, 'company', BRANCH), { ...(await read()), content_type: 'updated-company' });
    await getStore().setDoc(paths.contentType(ORG, SITE, 'company'), { ...schema, fields: [] } as unknown as Record<string, unknown>);
    await write(BRANCH, false);
    const original = await read(BRANCH);
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read()).content_type).toBe('updated-company');
    expect((await read())._provenance).toEqual(original._provenance);
    await expect(write('main', true, 'owner')).resolves.toBeUndefined();
  });

  it('rejects stale branch research before any content is promoted when main has an owner answer', async () => {
    await write(BRANCH, true);
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    await write('main', false, 'owner');
    await vstore.writePage(ORG, SITE, BRANCH, 'another', { title: 'Unrelated new page', status: 'published' });
    const before = await read();
    await expect(promoteBranch(ORG, SITE, BRANCH)).rejects.toThrow();
    expect(await read()).toEqual(before);
    expect(await vstore.page(ORG, SITE, 'main', 'another')).toBeNull();
  });

  it('rejects an older source even when both source and destination were written by research', async () => {
    await write(BRANCH, true);
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    await write('main', false);
    const before = await read();
    await expect(promoteBranch(ORG, SITE, BRANCH)).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it.each([false, null])('keeps accepted owner %s attribution through promotion and rejects later imports', async answer => {
    await write('main', true);
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    await write(BRANCH, answer, 'owner');
    const original = (await read(BRANCH))._provenance;
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read()).fields?.support).toEqual({ training: answer });
    expect((await read())._provenance).toEqual(original);
    await expect(write('main', true, 'import')).rejects.toThrow('higher-precedence');
  });

  it('does not elevate unchanged research by copying it in an unrelated branch edit', async () => {
    await write('main', true);
    const original = (await read())._provenance?.['support/training'];
    await vstore.writePage(ORG, SITE, BRANCH, 'company', { title: 'Edited heading' }, { actor: 'portal', actorId: 'synthetic-editor' });
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read())._provenance?.['support/training']).toEqual(original);
    await expect(write('main', false, 'owner')).resolves.toBeUndefined();
  });

  it('retains a real newer owner decision whose final value happens to match main', async () => {
    await write('main', true);
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    await write(BRANCH, false, 'owner');
    vi.setSystemTime(new Date('2026-01-03T12:00:00Z'));
    await write(BRANCH, true, 'owner');
    const original = (await read(BRANCH))._provenance;
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read())._provenance).toEqual(original);
    await expect(write('main', false, 'import')).rejects.toThrow('higher-precedence');
  });

  it('leaves unattributed legacy facts unattributed and never invents an administrator confirmation', async () => {
    await getStore().setDoc(paths.page(ORG, SITE, 'company', BRANCH), { ...(await read()), fields: { support: { training: true } } });
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read())._provenance).toEqual({});
    await expect(write('main', false, 'owner')).resolves.toBeUndefined();
  });

  it('rejects caller-forged provenance and non-administrative promotion contexts', async () => {
    await write(BRANCH, true);
    const original = await read(BRANCH), before = await read();
    await expect(vstore.writePage(ORG, SITE, 'main', 'company', { ...original, _provenance: {} },
      { actor: 'portal', actorId: 'synthetic', promotedFrom: BRANCH })).rejects.toThrow('Source Page changed');
    await expect(vstore.writePage(ORG, SITE, 'main', 'company', original,
      { actor: 'agent', actorId: 'synthetic', promotedFrom: BRANCH })).rejects.toThrow('Invalid Page promotion');
    expect(await read()).toEqual(before);
  });

  it.each(['page', 'schema', 'version'])('guards the persisted source %s at the destination commit boundary', async kind => {
    await write(BRANCH, true);
    const store = getStore(), before = await read();
    const compare = store.compareAndReplaceDoc.bind(store);
    vi.spyOn(store, 'compareAndReplaceDoc').mockImplementationOnce(async (path, expected, next, effects) => {
      if (kind === 'page') await store.updateDoc(paths.page(ORG, SITE, 'company', BRANCH), { title: 'Concurrent source edit' });
      if (kind === 'schema') await store.updateDoc(paths.contentType(ORG, SITE, 'company'), { label_singular: 'Concurrent schema edit' });
      if (kind === 'version') await store.updateDoc(paths.version(ORG, SITE, BRANCH), { base_version_id: 'another-branch' });
      return compare(path, expected, next, effects);
    });
    await expect(promoteBranch(ORG, SITE, BRANCH)).rejects.toThrow('changed');
    expect(await read()).toEqual(before);
  });

  it('keeps immutable program IDs and per-option No and clear sources across promotion', async () => {
    const programSchema = { ...schema, fields: [...schema.fields, {
      name: 'programs', label: 'Programs', type: 'array', item_key: 'id', writable_by: ['portal', 'owner', 'agent', 'import'], fields: [
        { name: 'id', label: 'Identity', type: 'text', writable_by: ['portal', 'agent', 'import'] },
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'online', label: 'Online?', type: 'boolean' },
      ],
    }] };
    await getStore().setDoc(paths.contentType(ORG, SITE, 'company'), programSchema);
    await vstore.writePage(ORG, SITE, 'main', 'company', { fields: { programs: [
      { id: 'catalog', name: 'Catalog', online: true }, { id: 'store', name: 'Store', online: true },
    ] } }, { actor: 'agent', actorId: 'synthetic-research' });
    await vstore.writePage(ORG, SITE, BRANCH, 'company', { fields: { programs: [
      { id: 'store', name: 'Renamed store', online: null }, { id: 'catalog', name: 'Catalog', online: false },
    ] } }, { actor: 'owner', actorId: 'synthetic-owner' });
    const original = await read(BRANCH);
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await read()).fields?.programs).toEqual(original.fields?.programs);
    expect((await read())._provenance).toEqual(original._provenance);
    await expect(vstore.writePage(ORG, SITE, 'main', 'company', { fields: { programs: [] } },
      { actor: 'import', actorId: 'synthetic-import' })).rejects.toThrow('higher-precedence');
  });
});
