// A media import whose record exists but whose copy failed for a passing
// reason (a busy source, an interrupted transfer, a 5xx from the transfer
// Worker) stays pending. The Site's media migration retries it on this
// schedule, inside that migration job; nothing polls the source otherwise.
import type { Media } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';

/**
 * Delay before each automatic retry of a pending import, and of a stored file whose
 * migration copy failed for a passing reason. After the last one fails, the file is
 * set aside until someone retries it.
 */
export const IMPORT_RETRY_DELAYS_MS = [1, 5, 15, 30, 60].map(minutes => minutes * 60_000);

export type ImportingMedia = Media & {
  source_url?: string; import_pending?: boolean; import_rejected?: boolean; import_error?: string | null; import_error_code?: string | null;
  /** Failed copy attempts since the last success or manual retry. */
  import_failures?: number;
  /** When the migration tries the copy again; null when no automatic retry is planned. */
  import_retry_at?: string | null;
  /** `transient`: the copy failed for a passing reason on every automatic retry; a retry from Publishing may succeed. */
  migration_failed?: boolean; migration_error?: { code: string; message: string; at: string; transient?: boolean } | null;
  /** Failed migration copies of a stored file since the last success or manual retry, and when the next one runs. */
  migration_failures?: number; migration_retry_at?: string | null;
};

/**
 * Failures that cannot succeed by trying again unchanged: the transfer service
 * refused the source or the file (4xx). A rate limit (429) or a concurrent
 * change to the record (409) passes.
 */
export const permanentImportFailure = (error: unknown) => error instanceof ConnectionError && error.status < 500 && error.status !== 429 && error.status !== 409;

export const importFailure = (error: unknown): { code: string; message: string } => error instanceof ConnectionError
  ? { code: error.code ?? 'media_transfer_unavailable', message: error.message }
  : { code: 'media_transfer_interrupted', message: 'The transfer was interrupted.' };

/**
 * Records a passing failure on a pending import and plans its next attempt.
 * `restart` begins the schedule again (an import someone just requested);
 * otherwise the failure counts towards it. Returns the next attempt time, or
 * null when the schedule is used up.
 */
export async function scheduleImportRetry(store: ReadWriteStore, mediaPath: string, error: unknown, options: { restart?: boolean; now?: number } = {}): Promise<number | null> {
  const now = options.now ?? Date.now();
  const current = await store.getDoc<ImportingMedia>(mediaPath);
  const failures = options.restart ? 1 : (current?.import_failures ?? 0) + 1;
  const delay = IMPORT_RETRY_DELAYS_MS[failures - 1];
  const retryAt = delay === undefined ? null : now + delay;
  const failure = importFailure(error);
  await store.updateDoc(mediaPath, { import_pending: true, import_error: failure.message, import_error_code: failure.code, import_failures: failures,
    import_retry_at: retryAt === null ? null : new Date(retryAt).toISOString(),
    // A requested import is retried automatically again, even if an earlier
    // migration pass had set the file aside.
    ...(options.restart ? { migration_failed: false, migration_error: null } : {}) });
  return retryAt;
}

/** Milliseconds since epoch of a planned retry still in the future, or null when the copy may run now. */
export function importRetryPending(media: ImportingMedia, now = Date.now()): number | null {
  const at = media.import_retry_at ? Date.parse(media.import_retry_at) : NaN;
  return Number.isFinite(at) && at > now ? at : null;
}

export interface ImportStatus {
  state: 'pending' | 'complete' | 'failed';
  error_code: string | null;
  message: string | null;
  retry: { automatic: boolean; next_attempt_at: string | null; failed_attempts: number } | null;
}

/** The import state an API caller polls instead of importing again; null for media that was not imported from a URL. */
export function importStatus(media: ImportingMedia): ImportStatus | null {
  if (!media.source_url) return null;
  if (media.storage?.state === 'ready') return { state: 'complete', error_code: null, message: null, retry: null };
  if (media.import_rejected) return { state: 'failed', error_code: media.import_error_code ?? 'media_svg_invalid', message: media.import_error ?? null, retry: { automatic: false, next_attempt_at: null, failed_attempts: media.import_failures ?? 0 } };
  if (media.migration_failed) return { state: 'failed', error_code: media.migration_error?.code ?? media.import_error_code ?? 'media_transfer_unavailable',
    message: media.migration_error?.message ?? media.import_error ?? null, retry: { automatic: false, next_attempt_at: null, failed_attempts: media.import_failures ?? 0 } };
  if (media.import_pending) return { state: 'pending', error_code: media.import_error_code ?? null, message: media.import_error ?? null,
    retry: { automatic: true, next_attempt_at: media.import_retry_at ?? null, failed_attempts: media.import_failures ?? 0 } };
  return null;
}

/** A transient import failure after the media record exists: the file stays pending and is retried automatically. */
export class MediaImportPendingError extends ConnectionError {
  constructor(public mediaId: string, public original: unknown, public retryAt: number | null) {
    const failure = importFailure(original);
    super(failure.message, 503, failure.code, original instanceof ConnectionError ? original.details : undefined);
  }
}
