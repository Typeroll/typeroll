// The generic half of canonical publication: an installed app computing
// published data from frozen accepted content, as part of a normal build.
//
// Almost everything here is a rejection. A derivation that half-works
// publishes a site that is subtly missing data, which is the failure the whole
// mechanism exists to remove — so a malformed result is refused rather than
// repaired.

import { describe, it, expect } from 'vitest';
import {
  DerivationError,
  derivationCacheKey,
  derivationInputDigest,
  runBuildDerivations,
  stableDigest,
  validateDerivationResult,
  type DerivationInput,
} from '../../lib/publishing/build-derivation';

const input: DerivationInput = {
  org_id: 'fundraiserchart',
  site_id: 'fc',
  version_id: 'main',
  content_digest: 'content-1',
  config_digest: 'config-1',
  provider_version: '1.0.0',
};

const ok = (over: Record<string, unknown> = {}) => ({
  input_digest: derivationInputDigest(input),
  sources: [{ id: 'directory.profiles', records: [{ id: 'acme', supports: true }] }],
  receipts: [{ kind: 'query', id: 'companies', count: 1 }],
  ...over,
});

describe('stableDigest', () => {
  it('ignores key order, so an unrelated reserialisation does not invalidate a build', () => {
    expect(stableDigest({ a: 1, b: 2 })).toBe(stableDigest({ b: 2, a: 1 }));
  });

  it('distinguishes values that differ', () => {
    expect(stableDigest({ a: 1 })).not.toBe(stableDigest({ a: 2 }));
  });

  it('does not conflate an absent key with an explicit undefined', () => {
    expect(stableDigest({ a: 1, b: undefined })).toBe(stableDigest({ a: 1 }));
  });
});

describe('derivationInputDigest', () => {
  it('changes when the provider version changes, so a new release cannot reuse old output', () => {
    expect(derivationInputDigest(input)).not.toBe(derivationInputDigest({ ...input, provider_version: '1.0.1' }));
  });

  it('changes when the configuration changes even though the content did not', () => {
    expect(derivationInputDigest(input)).not.toBe(derivationInputDigest({ ...input, config_digest: 'config-2' }));
  });
});

describe('validateDerivationResult', () => {
  it('accepts a well-formed result', () => {
    const result = validateDerivationResult(ok(), input, 'directory');
    expect(result.sources[0]!.id).toBe('directory.profiles');
    expect(result.receipts).toEqual([{ kind: 'query', id: 'companies', count: 1 }]);
  });

  it('rejects a result computed from a different input', () => {
    // Either the provider used other content, or a stale response was replayed.
    expect(() => validateDerivationResult(ok({ input_digest: 'somethingelse' }), input, 'directory'))
      .toThrow(/does not match the input/);
  });

  it('rejects a source id that would shadow a renderer namespace', () => {
    for (const id of ['page', 'site.things', 'item']) {
      expect(() => validateDerivationResult(ok({ sources: [{ id, records: [] }] }), input, 'directory'))
        .toThrow(/reserved namespace/);
    }
  });

  it('rejects a source id that is not a plain dotted path', () => {
    for (const id of ['../escape', 'Directory.Profiles', 'a/b', '', 'a..b']) {
      expect(() => validateDerivationResult(ok({ sources: [{ id, records: [] }] }), input, 'directory'))
        .toThrow(/Invalid derived source id/);
    }
  });

  it('rejects duplicate sources from one provider', () => {
    expect(() => validateDerivationResult(ok({
      sources: [{ id: 'directory.profiles', records: [] }, { id: 'directory.profiles', records: [] }],
    }), input, 'directory')).toThrow(/Duplicate derived source/);
  });

  it('rejects a non-object record rather than dropping it', () => {
    expect(() => validateDerivationResult(ok({
      sources: [{ id: 'directory.profiles', records: [{ id: 'a' }, 'not-a-record'] }],
    }), input, 'directory')).toThrow(/non-object record/);
  });

  it('accepts an empty source with a receipt — an empty listing still has dependencies', () => {
    const result = validateDerivationResult(ok({
      sources: [{ id: 'directory.profiles', records: [] }],
      receipts: [{ kind: 'query', id: 'companies', count: 0 }],
    }), input, 'directory');
    expect(result.sources[0]!.records).toEqual([]);
    expect(result.receipts[0]!.count).toBe(0);
  });

  it('rejects records with no receipts at all — nothing would ever invalidate them', () => {
    expect(() => validateDerivationResult(ok({ receipts: [] }), input, 'directory'))
      .toThrow(/no dependency receipts/);
  });

  it('rejects a receipt with a missing or negative count, but keeps zero', () => {
    expect(() => validateDerivationResult(ok({ receipts: [{ kind: 'query', id: 'c' }] }), input, 'directory'))
      .toThrow(/non-negative integer count/);
    expect(() => validateDerivationResult(ok({ receipts: [{ kind: 'query', id: 'c', count: -1 }] }), input, 'directory'))
      .toThrow(/non-negative integer count/);
    expect(validateDerivationResult(ok({ receipts: [{ kind: 'query', id: 'c', count: 0 }] }), input, 'directory').receipts[0]!.count)
      .toBe(0);
  });

  it('names the provider on the error, so a multi-app build says which one failed', () => {
    try {
      validateDerivationResult('nonsense', input, 'directory');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DerivationError);
      expect((error as DerivationError).provider).toBe('directory');
    }
  });
});

describe('derivationCacheKey', () => {
  it('is stable across receipt ordering', () => {
    const a = [{ kind: 'query', id: 'a', count: 1 }, { kind: 'query', id: 'b', count: 2 }];
    expect(derivationCacheKey(input, a)).toBe(derivationCacheKey(input, [...a].reverse()));
  });

  it('changes when a consulted count changes, even at the same content digest', () => {
    // Same content, different configuration deciding which records are consulted.
    expect(derivationCacheKey(input, [{ kind: 'query', id: 'a', count: 1 }]))
      .not.toBe(derivationCacheKey(input, [{ kind: 'query', id: 'a', count: 2 }]));
  });
});

describe('runBuildDerivations', () => {
  const provider = (id: string, request: (i: DerivationInput) => Promise<unknown>, required = true) =>
    ({ id, version: '1.0.0', request, required });

  it('merges sources from several providers and keys each separately', async () => {
    const outcome = await runBuildDerivations(input, [
      provider('directory', async (i) => ({
        input_digest: derivationInputDigest(i),
        sources: [{ id: 'directory.profiles', records: [{ id: 'a' }] }],
        receipts: [{ kind: 'query', id: 'companies', count: 1 }],
      })),
      provider('attribution', async (i) => ({
        input_digest: derivationInputDigest(i),
        sources: [{ id: 'attribution.rules', records: [] }],
        receipts: [{ kind: 'query', id: 'rules', count: 0 }],
      })),
    ]);
    expect(outcome.sources.map((s) => s.id)).toEqual(['directory.profiles', 'attribution.rules']);
    expect(Object.keys(outcome.cache_keys)).toEqual(['directory', 'attribution']);
    expect(outcome.skipped).toEqual([]);
  });

  it('refuses a source claimed by two providers rather than letting one overwrite the other', async () => {
    const same = async (i: DerivationInput) => ({
      input_digest: derivationInputDigest(i),
      sources: [{ id: 'directory.profiles', records: [] }],
      receipts: [{ kind: 'query', id: 'q', count: 0 }],
    });
    await expect(runBuildDerivations(input, [provider('one', same), provider('two', same)]))
      .rejects.toThrow(/produced by both one and two/);
  });

  it('fails the build when a required provider fails, so the live site is left alone', async () => {
    await expect(runBuildDerivations(input, [
      provider('directory', async () => { throw new Error('provider unreachable'); }),
    ])).rejects.toThrow(/provider unreachable/);
  });

  it('records an optional provider failure instead of swallowing it', async () => {
    const outcome = await runBuildDerivations(input, [
      provider('attribution', async () => { throw new Error('provider unreachable'); }, false),
    ]);
    expect(outcome.sources).toEqual([]);
    expect(outcome.skipped).toEqual([{ provider: 'attribution', reason: 'provider unreachable' }]);
  });

  it('gives each provider its own version in the digest it must echo', async () => {
    const seen: string[] = [];
    await runBuildDerivations(input, [
      { id: 'directory', version: '2.5.0', required: true, request: async (i) => {
        seen.push(i.provider_version);
        return { input_digest: derivationInputDigest(i), sources: [], receipts: [] };
      } },
    ]);
    expect(seen).toEqual(['2.5.0']);
  });

  it('rejects a provider echoing the digest of a different provider version', async () => {
    await expect(runBuildDerivations(input, [
      { id: 'directory', version: '2.5.0', required: true, request: async () =>
        ({ input_digest: derivationInputDigest(input), sources: [], receipts: [] }) },
    ])).rejects.toThrow(/does not match the input/);
  });
});
