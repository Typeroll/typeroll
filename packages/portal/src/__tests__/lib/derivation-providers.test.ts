// Which apps derive, what they are given, and what a build depends on.
//
// The digests are the load-bearing part: they decide when derived output may
// be reused, and getting them wrong produces data that looks correct while
// being stale — which is the exact failure canonical publication exists to
// remove.

import { describe, it, expect } from 'vitest';
import { publicationConfigDigest, publicationContentDigest } from '../../lib/publishing/derivation-providers';

const resolved = {
  versionId: 'main',
  pages: [{ id: 'acme', fields: { supports: true } }],
  contentTypes: [{ id: 'company' }],
  blockTypes: [],
  pageTemplates: [],
  settings: { site_name: 'FC' },
};

const runtime = {
  apps: { apps: { integrations: { enabled: true, config: {} } } },
  extensions: { installations: [{ extension_id: 'directory', version: '1.0.0', public_config: { mapping: 'a' } }] },
};

describe('publicationContentDigest', () => {
  it('changes when an accepted answer changes', () => {
    const changed = { ...resolved, pages: [{ id: 'acme', fields: { supports: false } }] };
    expect(publicationContentDigest(resolved)).not.toBe(publicationContentDigest(changed));
  });

  it('changes when content types change, since they define what the answers mean', () => {
    expect(publicationContentDigest(resolved))
      .not.toBe(publicationContentDigest({ ...resolved, contentTypes: [{ id: 'program' }] }));
  });

  it('is unchanged by a rebuild of the same content', () => {
    expect(publicationContentDigest(resolved)).toBe(publicationContentDigest({ ...resolved }));
  });

  it('ignores media and domains, which cannot change what an answer is', () => {
    // A domain change must not invalidate every derivation on the site.
    const withNoise = { ...resolved, media: [{ id: 'x' }], site_url: 'https://example.com' } as typeof resolved;
    expect(publicationContentDigest(withNoise)).toBe(publicationContentDigest(resolved));
  });
});

describe('publicationConfigDigest', () => {
  it('changes when an installation config changes, at identical content', () => {
    const changed = { ...runtime, extensions: { installations: [{ extension_id: 'directory', version: '1.0.0', public_config: { mapping: 'b' } }] } };
    expect(publicationConfigDigest(runtime)).not.toBe(publicationConfigDigest(changed));
  });

  it('changes when the installed app version changes', () => {
    const changed = { ...runtime, extensions: { installations: [{ extension_id: 'directory', version: '1.1.0', public_config: { mapping: 'a' } }] } };
    expect(publicationConfigDigest(runtime)).not.toBe(publicationConfigDigest(changed));
  });

  it('does not depend on installation ordering', () => {
    const a = { ...runtime, extensions: { installations: [{ extension_id: 'a', version: '1' }, { extension_id: 'b', version: '1' }] } };
    const b = { ...runtime, extensions: { installations: [{ extension_id: 'b', version: '1' }, { extension_id: 'a', version: '1' }] } };
    expect(publicationConfigDigest(a)).toBe(publicationConfigDigest(b));
  });

  it('treats no installations as its own state', () => {
    expect(publicationConfigDigest({ apps: runtime.apps, extensions: { installations: [] } }))
      .not.toBe(publicationConfigDigest(runtime));
  });
});
