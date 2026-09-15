import { describe, it, expect } from 'vitest';
import { planUnifiedSiteMigration, type SiteDocuments } from '../../lib/migrations/unified-site-plan';
import { applyUnifiedSitePlan, type MigrationDocumentStore } from '../../lib/migrations/unified-site-apply';

const source: SiteDocuments = { 'versions/main/pages/a': { title: 'A', slug: 'a', content_mode: 'html', html_content: '<p>Text</p>', status: 'published' } };
const plan = planUnifiedSiteMigration(source, '2026-01-01');
function adapter(initial = source) {
  const data = structuredClone(initial);
  let frozen = true, failAfter = Infinity, writes = 0;
  const store: MigrationDocumentStore = {
    readAll: async () => structuredClone(data),
    assertWriteFreeze: async () => { if (!frozen) throw new Error('Not frozen'); },
    compareAndWrite: async (path, expected, next) => {
      if (writes++ === failAfter) throw new Error('Interrupted');
      if (JSON.stringify(data[path] ?? null) !== JSON.stringify(expected)) return false;
      if (next) data[path] = structuredClone(next); else delete data[path];
      return true;
    },
  };
  return { data, store, freeze: (value: boolean) => { frozen = value; }, interruptAfter: (value: number) => { failAfter = value; } };
}
describe('resumable offline cutover', () => {
  it('resumes interrupted writes using the same plan and verifies the full result', async () => {
    const target = adapter(); target.interruptAfter(1);
    await expect(applyUnifiedSitePlan(source, plan, target.store)).rejects.toThrow('Interrupted');
    expect(target.data['_migrations/unified-pages']).toBeUndefined();
    target.interruptAfter(Infinity);
    await applyUnifiedSitePlan(source, plan, target.store);
    expect(target.data).toEqual(plan.documents);
    expect((await applyUnifiedSitePlan(source, plan, target.store)).written).toBe(0);
  });
  it('refuses concurrent or unexpected documents before making changes', async () => {
    for (const changed of [{ ...source, 'versions/main/pages/extra': { title: 'New' } }, { ...source, 'versions/main/pages/a': { title: 'Changed' } }]) {
      const target = adapter(changed); const before = structuredClone(target.data);
      await expect(applyUnifiedSitePlan(source, plan, target.store)).rejects.toThrow(/Unexpected|changed outside/);
      expect(target.data).toEqual(before);
    }
  });
  it('requires a write freeze and rejects tampered plans', async () => {
    const target = adapter(); target.freeze(false);
    await expect(applyUnifiedSitePlan(source, plan, target.store)).rejects.toThrow('Not frozen');
    target.freeze(true);
    await expect(applyUnifiedSitePlan(source, { ...plan, result_hash: 'modified' }, target.store)).rejects.toThrow('modified');
    expect(target.data).toEqual(source);
  });
});
