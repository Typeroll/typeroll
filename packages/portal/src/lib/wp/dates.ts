import { schemaDate } from '@typeroll/shared';

/** WordPress REST's date_gmt/modified_gmt are UTC even without a suffix.
 * Never treat its local date/modified fields as UTC. */
export function wordpressDate(local: string, gmt?: string | null): string {
  if (gmt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(gmt)) {
    const utc = schemaDate(`${gmt}Z`);
    if (utc) return utc;
  }
  if (gmt && /(?:Z|[+-]\d{2}:\d{2})$/.test(gmt)) {
    const utc = schemaDate(gmt);
    if (utc) return utc;
  }
  return schemaDate(local) ?? '';
}
