// An idle delivery chain record expires through the store TTL; a busy one never does.
import { afterEach, expect, it } from 'vitest';
import { setRuntimeStore, type ReadWriteStore } from '../../lib/datastore';
import { CHAIN_IDLE_TTL_MS, requestChain, runChainDelivery } from '../../lib/scheduling/chain';
import { memoryStore } from '../helpers/identity';

afterEach(() => setRuntimeStore(null));

it('sets delete_at only while the chain is idle', async () => {
  const store: ReadWriteStore = memoryStore();
  setRuntimeStore(() => store);
  const record = async () => (await store.listDocs<Record<string, unknown>>('scheduling_chains'))[0]!;
  const sent: number[] = [];
  const enqueue = async (generation: number) => { sent.push(generation); };
  let clock = Date.parse('2026-11-05T12:00:00.000Z');

  await requestChain('media:o', 0, enqueue, clock);
  expect((await record()).delete_at).toBeNull();
  let during: unknown;
  await runChainDelivery('media:o', sent[0]!, async () => { during = (await record()).delete_at; return null; }, enqueue, () => clock);
  expect(during).toBeNull();
  const idle = await record();
  expect(idle.delete_at).toBe(clock + CHAIN_IDLE_TTL_MS);

  clock += 60_000;
  await requestChain('media:o', 1_000, enqueue, clock);
  expect((await record()).delete_at).toBeNull();
});
