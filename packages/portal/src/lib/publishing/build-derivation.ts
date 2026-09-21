// Build-time derivation: letting an installed app compute published data from
// frozen accepted content, as part of an ordinary publication.
//
// The problem this exists for: a customer's facts are stored once, in accepted
// Page fields, but the published site needs them in shapes nobody wants to
// maintain by hand — profile summaries, membership and counts, filter
// datasets, coverage lists. Without this, something outside publication has to
// regenerate stored mirrors after every approval, and an operator has to
// remember to run it. Mirrors then drift from the accepted answers they were
// derived from, and the drift is invisible until someone reads the site.
//
// THE RULE THAT MAKES IT SAFE: derivation reads a frozen input and returns
// data. It never writes CMS fields, never approves anything, never sends mail.
// A retry is therefore always safe, and an approval landing mid-build belongs
// to the next publication rather than half of this one.
//
// Core owns transport, validation, freezing and invalidation. It knows no
// company taxonomy, no support option, no state rule — those belong to the app
// and to the customer's configuration. This file should never need to change
// because a customer's rules changed.

import { createHash } from 'node:crypto';

/** What a provider is given. Immutable, and hashed so the result can be tied to it. */
export interface DerivationInput {
  org_id: string;
  site_id: string;
  version_id: string;
  /** Hash of the frozen accepted content this publication is building from. */
  content_digest: string;
  /** Hash of the public app configuration in force for it. */
  config_digest: string;
  /** The app release computing this. Part of the cache key — a new release must not reuse old output. */
  provider_version: string;
}

/** One derived dataset the site can render from. */
export interface DerivedSource {
  /**
   * Dot-separated, lowercase. Becomes a render namespace, so it is validated
   * rather than trusted: a provider must not be able to shadow `page`, `site`
   * or `item`, or smuggle a path separator into a filename.
   */
  id: string;
  records: Array<Record<string, unknown>>;
}

/**
 * What the provider consulted, so a later build knows whether it may reuse
 * this output.
 *
 * Membership is recorded even when EMPTY. A query that matched nothing still
 * depends on the records it examined — otherwise adding the first matching
 * record leaves a stale empty listing that nothing invalidates.
 */
export interface DerivationReceipt {
  kind: string;
  id: string;
  /** Number of records considered. Zero is meaningful and must be recorded. */
  count: number;
}

export interface DerivationResult {
  /** Echoed back by the provider; must equal what was sent. */
  input_digest: string;
  sources: DerivedSource[];
  receipts: DerivationReceipt[];
}

export class DerivationError extends Error {
  constructor(message: string, readonly provider: string) {
    super(message);
    this.name = 'DerivationError';
  }
}

/** Namespaces the renderer already owns. A derived source must not shadow one. */
const RESERVED_NAMESPACES = new Set(['page', 'site', 'item', 'content_type', 'pagination', 'facet', 'backlinks']);
const SOURCE_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_SOURCES = 64;
const MAX_RECORDS_PER_SOURCE = 50_000;

/** Stable hash of a value, independent of key order. */
export function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The digest a provider must echo.
 *
 * Covers the content, the configuration AND the provider version, so a new app
 * release cannot silently reuse output computed by the previous one — which is
 * the failure that makes derived data look correct while being stale.
 */
export function derivationInputDigest(input: DerivationInput): string {
  return stableDigest({
    org: input.org_id,
    site: input.site_id,
    version: input.version_id,
    content: input.content_digest,
    config: input.config_digest,
    provider: input.provider_version,
  });
}

/**
 * Validate what a provider returned, before any of it reaches a renderer.
 *
 * Everything here is a rejection rather than a repair. A provider that returns
 * a malformed source has a bug, and quietly dropping the bad part would
 * publish a site that is subtly missing data — the exact failure mode this
 * whole mechanism exists to remove.
 */
export function validateDerivationResult(
  raw: unknown,
  input: DerivationInput,
  provider: string,
): DerivationResult {
  // Annotated on the variable, not just the arrow, so TypeScript uses it for
  // control-flow narrowing after each call.
  const fail: (message: string) => never = (message) => { throw new DerivationError(message, provider); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Derivation result must be an object');
  const result = raw as Record<string, unknown>;

  const expected = derivationInputDigest(input);
  if (result.input_digest !== expected) {
    // Either the provider computed from something else, or a stale response
    // was replayed. Both mean the output does not describe this publication.
    fail('Derivation result does not match the input it was computed from');
  }

  if (!Array.isArray(result.sources)) fail('Derivation result must carry a sources array');
  const sources = result.sources as unknown[];
  if (sources.length > MAX_SOURCES) fail(`Derivation returned more than ${MAX_SOURCES} sources`);

  const seen = new Set<string>();
  const validated: DerivedSource[] = sources.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Each derived source must be an object');
    const source = entry as Record<string, unknown>;
    const id = String(source.id ?? '');
    if (!SOURCE_ID.test(id)) fail(`Invalid derived source id: ${id.slice(0, 64) || '(empty)'}`);
    if (RESERVED_NAMESPACES.has(id.split('.')[0]!)) fail(`Derived source may not shadow the reserved namespace: ${id}`);
    if (seen.has(id)) fail(`Duplicate derived source: ${id}`);
    seen.add(id);
    if (!Array.isArray(source.records)) fail(`Derived source ${id} must carry a records array`);
    const records = source.records as unknown[];
    if (records.length > MAX_RECORDS_PER_SOURCE) fail(`Derived source ${id} exceeds ${MAX_RECORDS_PER_SOURCE} records`);
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        fail(`Derived source ${id} contains a non-object record`);
      }
    }
    return { id, records: records as Array<Record<string, unknown>> };
  });

  if (!Array.isArray(result.receipts)) fail('Derivation result must carry a receipts array');
  const receipts: DerivationReceipt[] = (result.receipts as unknown[]).map((entry) => {
    if (!entry || typeof entry !== 'object') fail('Each receipt must be an object');
    const receipt = entry as Record<string, unknown>;
    const kind = String(receipt.kind ?? '');
    const id = String(receipt.id ?? '');
    const count = receipt.count;
    if (!kind || !id) fail('Each receipt must name a kind and an id');
    // Zero is valid and load-bearing; a missing or negative count is not.
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      fail(`Receipt ${kind}:${id} must carry a non-negative integer count`);
    }
    return { kind, id, count: count as number };
  });

  // A provider that consulted nothing cannot have derived anything from the
  // accepted content, so empty receipts alongside non-empty output means the
  // provider is not telling us what it depends on — and nothing would ever
  // invalidate the result.
  if (receipts.length === 0 && validated.some((source) => source.records.length > 0)) {
    fail('Derivation returned records but no dependency receipts');
  }

  return { input_digest: expected, sources: validated, receipts };
}

/**
 * The cache key for a derivation.
 *
 * Deliberately includes the receipts: two builds with identical content can
 * still depend on different record sets if the app's configuration changed
 * which records it consults. Reuse is only safe when the inputs AND what was
 * consulted both match.
 */
export function derivationCacheKey(input: DerivationInput, receipts: DerivationReceipt[]): string {
  return stableDigest({
    input: derivationInputDigest(input),
    receipts: [...receipts]
      .map((receipt) => ({ kind: receipt.kind, id: receipt.id, count: receipt.count }))
      .sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1)),
  });
}

/** How Core reaches a provider. Injected so the contract is testable without a network. */
export type DerivationTransport = (input: DerivationInput) => Promise<unknown>;

export interface DerivationProvider {
  /** Installation id — identifies which app computed this. */
  id: string;
  version: string;
  request: DerivationTransport;
  /** A provider the site cannot publish without. A failure here fails the build. */
  required: boolean;
}

export interface DerivationOutcome {
  sources: DerivedSource[];
  receipts: DerivationReceipt[];
  cache_keys: Record<string, string>;
  /** Providers that failed but were not required. Surfaced, never swallowed. */
  skipped: Array<{ provider: string; reason: string }>;
}

/**
 * Run every declared derivation for one publication.
 *
 * Providers are invoked with the same frozen input and their outputs merged.
 * A required provider's failure throws, which leaves the previous live
 * artifact untouched — publication activates only after every step succeeds,
 * so failing here is how the old site keeps serving.
 *
 * Source ids are global across providers, and a collision is an error rather
 * than a last-writer-wins merge: two apps silently overwriting each other's
 * data would be undetectable from the rendered page.
 */
export async function runBuildDerivations(
  input: DerivationInput,
  providers: DerivationProvider[],
): Promise<DerivationOutcome> {
  const sources: DerivedSource[] = [];
  const receipts: DerivationReceipt[] = [];
  const cache_keys: Record<string, string> = {};
  const skipped: DerivationOutcome['skipped'] = [];
  const owners = new Map<string, string>();

  for (const provider of providers) {
    const scoped: DerivationInput = { ...input, provider_version: provider.version };
    let result: DerivationResult;
    try {
      result = validateDerivationResult(await provider.request(scoped), scoped, provider.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Derivation failed';
      if (provider.required) throw new DerivationError(reason, provider.id);
      skipped.push({ provider: provider.id, reason });
      continue;
    }
    for (const source of result.sources) {
      const owner = owners.get(source.id);
      if (owner) {
        throw new DerivationError(`Derived source ${source.id} is produced by both ${owner} and ${provider.id}`, provider.id);
      }
      owners.set(source.id, provider.id);
      sources.push(source);
    }
    receipts.push(...result.receipts);
    cache_keys[provider.id] = derivationCacheKey(scoped, result.receipts);
  }

  return { sources, receipts, cache_keys, skipped };
}
