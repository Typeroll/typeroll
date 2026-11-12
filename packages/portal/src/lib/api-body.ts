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

/**
 * MCP block tools take `target: { kind, id }` to reach a partial or a
 * PageTemplate. Over REST the container is part of the path instead, so a
 * `target` sent to /pages/{pageId}/blocks is refused with the address that
 * takes it, rather than as just another unknown key.
 */
export function containerTargetError(siteId: string, target: unknown, suffix = ''): string | null {
  if (target === undefined || target === null) return null;
  const t = typeof target === 'object' && !Array.isArray(target) ? target as { kind?: unknown; id?: unknown } : {};
  const kind = typeof t.kind === 'string' && t.kind ? encodeURIComponent(t.kind) : '{kind}';
  const id = typeof t.id === 'string' && t.id ? encodeURIComponent(t.id) : '{id}';
  return (
    'target is not accepted on /pages/{pageId}/blocks: over REST the container is part of the path. ' +
    `Send the same body without target to /api/v1/sites/${encodeURIComponent(siteId)}/containers/${kind}/${id}/blocks${suffix} ` +
    '(kind: page, partial or template).'
  );
}

/** A `target` query parameter, plain or bracketed (target[kind]=…), as an object for containerTargetError. */
export function queryTarget(url: URL): Record<string, string> | undefined {
  const keys = [...url.searchParams.keys()].filter((key) => key === 'target' || key.startsWith('target[') || key.startsWith('target.'));
  if (!keys.length) return undefined;
  const target: Record<string, string> = {};
  for (const key of keys) {
    const match = /^target(?:\[(\w+)\]|\.(\w+))$/.exec(key);
    const field = match?.[1] ?? match?.[2];
    if (field) target[field] = url.searchParams.get(key) ?? '';
  }
  return target;
}

/**
 * The 400 message for a PATCH with nothing to write. MCP update tools take
 * the fields as a `patch` argument and send them at the top level of the
 * REST body; a REST caller that wraps them in `patch` is told so.
 */
export function noWritableFieldsError(body: unknown): string {
  const patch = body && typeof body === 'object' ? (body as { patch?: unknown }).patch : undefined;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'No writable fields in body';
  const keys = Object.keys(patch).slice(0, 3);
  return (
    'No writable fields in body. Send the fields at the top level of the body, not inside "patch" ' +
    `(for example { ${keys.map((key) => `"${key}": …`).join(', ')}${keys.length ? ', ' : ''}"save": true }); ` +
    '"patch" is the MCP tool argument that holds them.'
  );
}
