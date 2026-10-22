/** Preserve known offsets. A legacy local timestamp cannot establish an instant:
 * expose its known calendar date instead of inventing UTC or using server time. */
export function schemaDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return undefined;
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) return undefined;
  if (text.length === 10) return text;
  if (!Number.isFinite(Date.parse(match[2] ? text : `${text}Z`))) return undefined;
  return match[2] ? text : match[1];
}
