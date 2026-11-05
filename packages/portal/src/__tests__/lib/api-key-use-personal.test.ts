// Personal (OAuth) connections verify with an empty organization. Recording
// their use must not address `organizations//api_keys/…`, which the Durable
// Object store rejects as an invalid document path.
import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('does not touch the store for a personal connection', async () => {
  const { getStore } = await import('../../lib/datastore');
  const { recordKeyUse } = await import('../../lib/api-keys');
  const store = getStore();
  const getDoc = vi.spyOn(store, 'getDoc');
  const setDoc = vi.spyOn(store, 'setDoc');
  await recordKeyUse('', null, '0123456789ab', '192.0.2.1');
  expect(getDoc).not.toHaveBeenCalled();
  expect(setDoc).not.toHaveBeenCalled();
  await recordKeyUse('org', null, '0123456789ab');
  expect(getDoc).toHaveBeenCalledWith('organizations/org/api_keys/0123456789ab');
});
