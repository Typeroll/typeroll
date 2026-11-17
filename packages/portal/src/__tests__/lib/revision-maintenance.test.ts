import { beforeEach, expect, it, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { snapshotRevision } from '../../lib/revisions';
import { withBackgroundTasks } from '../../lib/runtime/background-tasks';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('persists a revision before returning but does not wait for history pruning', async () => {
  const store = getStore();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const list = vi.spyOn(store, 'listDocs').mockImplementation(async () => { await held; return []; });
  const tasks: Promise<unknown>[] = [];
  const id = await withBackgroundTasks(task => tasks.push(task), () => snapshotRevision({ orgId: 'o', siteId: 's', versionId: 'main', kind: 'page', resourceIds: ['p'], doc: { title: 'Before' }, createdBy: 'test' }));
  expect(await store.getDoc(`${paths.revisions('o', 's', 'p', 'main')}/${id}`)).toMatchObject({ doc: { title: 'Before' } });
  expect(tasks).toHaveLength(1);
  release(); await Promise.all(tasks); list.mockRestore();
});
