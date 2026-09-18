import { runDueScheduledWork, type WorkResult } from './scheduling/worker';
export type SweepResult = WorkResult;

/** Compatibility of the operational endpoint, not periodic scanning of sites.
 * Only due indexed work and existing pending migration records are considered. */
export async function runPublishSweep(now = new Date()): Promise<SweepResult> {
  const { runPendingMediaMigrations } = await import('./publishing/media-migration');
  await runPendingMediaMigrations();
  return runDueScheduledWork(now);
}
