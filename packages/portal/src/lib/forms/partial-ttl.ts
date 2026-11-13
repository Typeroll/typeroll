/**
 * Validate a form's `partial_ttl_days`: unfinished submissions are deleted this
 * many days after their last step. Returns the value, `undefined` when absent,
 * or an error message.
 */
export function parsePartialTtlDays(value: unknown): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3650) {
    return 'partial_ttl_days must be a whole number of days from 1 to 3650';
  }
  return value;
}
