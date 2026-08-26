// Strict body-shape validation for the v1 block-mutation endpoints.
//
// These routes take small flat JSON bodies. Without this check, a
// misspelled or wrongly nested key (e.g. { block_id, patch: { data } })
// was silently ignored — the mutation applied nothing and the route still
// returned 200, so the caller believed the write succeeded. Reject such
// requests instead, naming the offending keys and listing the accepted
// ones so the caller can self-correct.

export function bodyShapeError(
  body: Record<string, unknown>,
  allowed: readonly string[],
  opts?: { requireOneOf?: readonly string[] },
): string | null {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return (
      `Unknown body key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
      `Accepted keys: ${allowed.join(', ')}.`
    );
  }
  if (opts?.requireOneOf && !opts.requireOneOf.some((k) => body[k] !== undefined)) {
    return `Nothing to apply — include at least one of: ${opts.requireOneOf.join(', ')}.`;
  }
  return null;
}
