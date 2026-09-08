import { paths, type DeployCost } from '@typeroll/shared';
import { getStore } from '../datastore';
import { computeDeployCost, getRateCard } from '../deploy/cost';

/** Record active publisher work, excluding the customer's asynchronous build and queue backoff. */
export async function recordCustomerCompute(orgId: string, siteId: string, jobId: string, durationMs: number) {
  const path = paths.deploy(orgId, siteId, jobId), store = getStore();
  for (let retry = 0; retry < 5; retry++) {
    const job = await store.getDoc<{ cost?: DeployCost }>(path);
    if (!job) return;
    const previous = job.cost;
    // Freeze the estimate's rate card on the first active attempt, just like legacy builds.
    const rates = previous ? { ...previous.rates, currency: previous.currency, vcpu: previous.vcpu, memory_gib: previous.memory_gib } : getRateCard();
    const cost = computeDeployCost({ durationMs: (previous?.duration_s ?? 0) * 1000 + Math.max(0, durationMs),
      requestCount: (previous?.requests ?? 0) + 1, rates });
    const saved = await store.compareAndUpdateDoc<{ cost?: DeployCost }>(path,
      current => JSON.stringify(current.cost) === JSON.stringify(previous), { cost });
    if (saved) return;
  }
  throw new Error('Customer publishing cost accounting changed concurrently');
}
