import { AsyncLocalStorage } from 'node:async_hooks';
import { withoutRequestTiming } from './request-timing';

const background = new AsyncLocalStorage<(task: Promise<unknown>) => void>();

export function withBackgroundTasks<T>(waitUntil: (task: Promise<unknown>) => void, work: () => T): T {
  return background.run(waitUntil, work);
}

/** Only optional maintenance belongs here, never content or authorization writes.
 * Workers keep it alive after the response; local tools await the same work.
 */
export async function runMaintenance(work: () => Promise<void>): Promise<void> {
  const task = withoutRequestTiming(work).catch(() => { console.warn('[maintenance] revision pruning deferred until the next save'); });
  const waitUntil = background.getStore();
  if (waitUntil) waitUntil(task);
  else await task;
}
