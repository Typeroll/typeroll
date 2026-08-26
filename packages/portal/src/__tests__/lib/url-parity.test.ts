// Parity classifier: what the deployed site ACTUALLY answers for every old
// URL. The verdicts drive a go/no-go decision on DNS cutover, so each one is
// pinned here with a hand-built fetch.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Redirect } from '@typeroll/shared';
import { checkUrlParity, recordRedirectVerification } from '../../lib/wp/url-parity';

const ORG = 'orgone';
const SITE = 'mysite';
const TARGET = 'https://mysite.sites.example.com';

/** Build a fetch that answers from a routing table keyed on full URL. */
function fakeFetch(routes: Record<string, { status: number; location?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const hit = routes[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    const headers = new Headers();
    if (hit.location) headers.set('location', hit.location);
    return new Response(null, { status: hit.status, headers });
  }) as unknown as typeof fetch;
}

describe('checkUrlParity', () => {
  it('classifies a preserved path as ok', async () => {
    const { results, summary } = await checkUrlParity([{ path: '/om-oss' }], {
      targetOrigin: TARGET,
      fetchImpl: fakeFetch({ [`${TARGET}/om-oss`]: { status: 200 } }),
    });
    expect(results[0].verdict).toBe('ok');
    expect(results[0].status).toBe(200);
    expect(summary.ok).toBe(1);
  });

  it('follows a redirect chain to a 200 and reports the hops', async () => {
    const { results } = await checkUrlParity([{ path: '/gamla-tjanster' }], {
      targetOrigin: TARGET,
      fetchImpl: fakeFetch({
        [`${TARGET}/gamla-tjanster`]: { status: 301, location: '/tjanster' },
        [`${TARGET}/tjanster`]: { status: 200 },
      }),
    });
    expect(results[0].verdict).toBe('ok_redirect');
    expect(results[0].hops).toBe(1);
    expect(results[0].final_url).toBe(`${TARGET}/tjanster`);
    expect(results[0].final_status).toBe(200);
  });

  it('flags a 404 as missing — the gap a cutover would ship', async () => {
    const { results, summary } = await checkUrlParity([{ path: '/kampanj-2019' }], {
      targetOrigin: TARGET,
      fetchImpl: fakeFetch({ [`${TARGET}/kampanj-2019`]: { status: 404 } }),
    });
    expect(results[0].verdict).toBe('missing');
    expect(summary.missing).toBe(1);
  });

  it('flags a redirect that lands on a 404 as missing, not ok_redirect', async () => {
    // The exact case coverage analysis cannot see: a redirect rule exists,
    // so the URL reads as "redirected", but its target was never published.
    const { results } = await checkUrlParity([{ path: '/gammal' }], {
      targetOrigin: TARGET,
      fetchImpl: fakeFetch({
        [`${TARGET}/gammal`]: { status: 301, location: '/ny' },
        [`${TARGET}/ny`]: { status: 404 },
      }),
    });
    expect(results[0].verdict).toBe('missing');
    expect(results[0].hops).toBe(1);
  });

  it('detects a redirect loop instead of hanging', async () => {
    const { results } = await checkUrlParity([{ path: '/a' }], {
      targetOrigin: TARGET,
      maxHops: 3,
      fetchImpl: fakeFetch({
        [`${TARGET}/a`]: { status: 301, location: '/b' },
        [`${TARGET}/b`]: { status: 301, location: '/a' },
      }),
    });
    expect(results[0].verdict).toBe('broken_redirect');
    expect(results[0].error).toContain('too many hops');
  });

  it('treats a self-referential redirect as broken', async () => {
    const { results } = await checkUrlParity([{ path: '/loop' }], {
      targetOrigin: TARGET,
      fetchImpl: fakeFetch({ [`${TARGET}/loop`]: { status: 301, location: '/loop' } }),
    });
    expect(results[0].verdict).toBe('broken_redirect');
    expect(results[0].error).toContain('self-referential');
  });

  it('reports a network failure as error, never as missing', async () => {
    const { results } = await checkUrlParity([{ path: '/flaky' }], {
      targetOrigin: TARGET,
      fetchImpl: (async () => {
        throw new Error('ETIMEDOUT');
      }) as unknown as typeof fetch,
    });
    expect(results[0].verdict).toBe('error');
    expect(results[0].error).toContain('ETIMEDOUT');
  });

  it('skips excluded entries without a request', async () => {
    const { results, summary } = await checkUrlParity(
      [{ path: '/wp-admin', excluded: true }],
      {
        targetOrigin: TARGET,
        fetchImpl: (async () => {
          throw new Error('should not be called');
        }) as unknown as typeof fetch,
      },
    );
    expect(results[0].verdict).toBe('excluded');
    expect(summary.excluded).toBe(1);
  });

  it('records the old site status when asked, so pre-existing 404s are visible', async () => {
    const { results } = await checkUrlParity([{ path: '/redan-dod' }], {
      targetOrigin: TARGET,
      sourceOrigin: 'https://old.example.com',
      checkSource: true,
      fetchImpl: fakeFetch({
        'https://old.example.com/redan-dod': { status: 404 },
        [`${TARGET}/redan-dod`]: { status: 404 },
      }),
    });
    expect(results[0].verdict).toBe('missing');
    expect(results[0].source_status).toBe(404);
  });

  it('sorts gaps first, then by GSC clicks', async () => {
    const { results } = await checkUrlParity(
      [
        { path: '/fine' },
        { path: '/gap-small', gsc_clicks: 5 },
        { path: '/gap-big', gsc_clicks: 900 },
      ],
      {
        targetOrigin: TARGET,
        fetchImpl: fakeFetch({
          [`${TARGET}/fine`]: { status: 200 },
          [`${TARGET}/gap-small`]: { status: 404 },
          [`${TARGET}/gap-big`]: { status: 404 },
        }),
      },
    );
    expect(results.map((r) => r.path)).toEqual(['/gap-big', '/gap-small', '/fine']);
  });
});

describe('recordRedirectVerification', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  async function seedRedirect(id: string, doc: Partial<Redirect>): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
      from_path: '/x', to_path: '/y', status_code: 301, ...doc,
    });
  }

  it('stamps verified true for a rule whose URL resolved', async () => {
    const { getStore } = await import('../../lib/datastore');
    await seedRedirect('gammal', { from_path: '/gammal', to_path: '/ny' });
    const written = await recordRedirectVerification(
      getStore(), ORG, SITE, MAIN_VERSION_ID,
      [{ id: 'gammal', from_path: '/gammal', to_path: '/ny', status_code: 301 }],
      [{ path: '/gammal', verdict: 'ok_redirect', status: 301 }],
    );
    expect(written).toBe(1);
    const doc = await getStore().getDoc<Redirect>(
      `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/gammal`,
    );
    expect(doc?.verified).toBe(true);
    expect(doc?.last_checked).toBeTruthy();
  });

  it('stamps verified false when the rule led nowhere', async () => {
    const { getStore } = await import('../../lib/datastore');
    await seedRedirect('trasig', { from_path: '/trasig', to_path: '/borta' });
    await recordRedirectVerification(
      getStore(), ORG, SITE, MAIN_VERSION_ID,
      [{ id: 'trasig', from_path: '/trasig', to_path: '/borta', status_code: 301 }],
      [{ path: '/trasig', verdict: 'missing', status: 404 }],
    );
    const doc = await getStore().getDoc<Redirect>(
      `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/trasig`,
    );
    expect(doc?.verified).toBe(false);
  });

  it('leaves rules alone when the check was inconclusive or never ran', async () => {
    const { getStore } = await import('../../lib/datastore');
    await seedRedirect('timeout', { from_path: '/timeout', to_path: '/mal' });
    await seedRedirect('okontrollerad', { from_path: '/okontrollerad', to_path: '/mal' });
    const written = await recordRedirectVerification(
      getStore(), ORG, SITE, MAIN_VERSION_ID,
      [
        { id: 'timeout', from_path: '/timeout', to_path: '/mal', status_code: 301 },
        { id: 'okontrollerad', from_path: '/okontrollerad', to_path: '/mal', status_code: 301 },
      ],
      [{ path: '/timeout', verdict: 'error', status: null }],
    );
    expect(written).toBe(0);
    const store = getStore();
    for (const id of ['timeout', 'okontrollerad']) {
      const doc = await store.getDoc<Redirect>(
        `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/${id}`,
      );
      expect(doc?.verified).toBeUndefined();
    }
  });
});
