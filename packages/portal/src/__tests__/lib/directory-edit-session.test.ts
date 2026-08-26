/**
 * The public edit surface behind a one-time link.
 *
 * This is an UNAUTHENTICATED write endpoint on a multi-tenant platform, so
 * the tests here are mostly about what it refuses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { CollectionItem } from '@typeroll/shared';

const ORG = 'default';
const SITE = 'dir';

const cookieJar = () => {
  const store = new Map<string, string>();
  return {
    jar: store,
    api: {
      get: (n: string) => (store.has(n) ? { value: store.get(n)! } : undefined),
      set: (n: string, v: string) => { store.set(n, v); },
      delete: (n: string) => { store.delete(n); },
    },
  };
};

async function seed() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'z'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.org(ORG), { name: 'D', slug: ORG, plan: 'free', created_at: 'x' });
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'Dir', hosting_adapter: 'cloudflare', domain: 'katalogen.se',
  });
  await store.setDoc(paths.apps(ORG, SITE), {
    apps: { directory: { enabled: true, config: { collection: 'companies', email_field: 'email' } } },
  });
  await store.setDoc(paths.collection(ORG, SITE, 'companies'), {
    name: 'companies', label_singular: 'Company', label_plural: 'Companies',
    fields: [
      { name: 'title', type: 'text', label: 'Name', writable_by: ['portal', 'owner', 'agent'] },
      { name: 'phone', type: 'text', label: 'Phone', writable_by: ['portal', 'owner'] },
      // Billing state — visible on the listing, but never the business's to set.
      { name: 'plan', type: 'text', label: 'Plan', writable_by: ['app'] },
      { name: 'internal', type: 'text', label: 'Internal note' },
    ],
  });
  await store.setDoc(paths.collectionItem(ORG, SITE, 'companies', 'c1'), {
    status: 'published', created_at: 'x', updated_at: 'x',
    title: 'Acme', phone: '070', plan: 'free', internal: 'staff only', email: 'biz@example.com',
  });
}

const issue = async () => {
  const { issueGrant } = await import('../../lib/edit-grants');
  return issueGrant({ orgId: ORG, siteId: SITE, collection: 'companies', itemId: 'c1', email: 'biz@example.com' });
};

const call = async (
  method: 'GET' | 'PUT',
  opts: { token?: string; cookies?: ReturnType<typeof cookieJar>['api']; body?: unknown },
) => {
  const mod = await import('../../pages/api/directory/[siteId]/session');
  const url = `https://app.typeroll.com/api/directory/${SITE}/session${opts.token ? `?t=${encodeURIComponent(opts.token)}` : ''}`;
  const ctx = {
    params: { siteId: SITE },
    cookies: opts.cookies ?? cookieJar().api,
    request: new Request(url, {
      method,
      ...(opts.body ? { body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } } : {}),
    }),
  };
  return (method === 'GET' ? mod.GET : mod.PUT)(ctx as never);
};

describe('redeem', () => {
  beforeEach(seed);

  it('returns only the owner-writable fields', async () => {
    const { token } = await issue();
    const res = await call('GET', { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    // `plan` is app-only and `internal` never opted in, so neither is even
    // shown — the business can't see what it can't edit.
    expect(body.fields.map((f: { name: string }) => f.name).sort()).toEqual(['phone', 'title']);
    expect(body.listing_id).toBe('c1');
  });

  it('sets a scoped, HttpOnly session cookie', async () => {
    const jar = cookieJar();
    const { token } = await issue();
    await call('GET', { token, cookies: jar.api });
    expect(jar.jar.get('tr_directory_edit')).toBeTruthy();
  });

  it('rejects a reused link but keeps the redeemed session working', async () => {
    const jar = cookieJar();
    const { token } = await issue();
    await call('GET', { token, cookies: jar.api });

    // The link itself is spent…
    expect((await call('GET', { token, cookies: cookieJar().api })).status).toBe(401);
    // …while the browser that redeemed it can still reload.
    expect((await call('GET', { cookies: jar.api })).status).toBe(200);
  });

  it('refuses with no token and no cookie', async () => {
    expect((await call('GET', {})).status).toBe(401);
  });
});

describe('writing', () => {
  beforeEach(seed);

  const session = async () => {
    const jar = cookieJar();
    const { token } = await issue();
    await call('GET', { token, cookies: jar.api });
    return jar.api;
  };

  const readItem = async () => {
    const { vstore } = await import('../../lib/version-store');
    return vstore.collectionItem(ORG, SITE, 'main', 'companies', 'c1') as Promise<CollectionItem>;
  };

  it('writes an owner-writable field and stamps provenance', async () => {
    const res = await call('PUT', { cookies: await session(), body: { phone: '08-1234' } });
    expect(res.status).toBe(200);
    const item = (await readItem()) as Record<string, unknown>;
    expect(item.phone).toBe('08-1234');
    expect((item._provenance as Record<string, { source: string }>).phone.source).toBe('owner');
  });

  it('silently drops a field the business may not write', async () => {
    // `plan` isn't in the whitelist at all, so it never reaches the authority
    // check — dropped by the schema filter, exactly like an unknown key.
    await call('PUT', { cookies: await session(), body: { plan: 'paid', internal: 'hacked' } });
    const item = (await readItem()) as Record<string, unknown>;
    expect(item.plan).toBe('free');
    expect(item.internal).toBe('staff only');
  });

  it('cannot publish or unpublish the listing', async () => {
    await call('PUT', { cookies: await session(), body: { status: 'draft' } });
    expect((await readItem()).status).toBe('published');
  });

  it('loses to a value the portal wrote', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.collectionItem(ORG, SITE, 'companies', 'c1'), {
      _provenance: { phone: { source: 'portal', actor: 'staff@x', updated_at: 'T' } },
    });
    const res = await call('PUT', { cookies: await session(), body: { phone: '000' } });
    expect(res.status).toBe(409);
    expect((await readItem() as Record<string, unknown>).phone).toBe('070');
  });

  it('refuses once the site disables the app, mid-session', async () => {
    const cookies = await session();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.apps(ORG, SITE), { apps: { directory: { enabled: false, config: {} } } });
    expect((await call('PUT', { cookies, body: { phone: '1' } })).status).toBe(403);
  });

  it('refuses once the grant is revoked, mid-session', async () => {
    // The reason grants are stored at all: an operator can cut someone off
    // after the link has already been redeemed.
    const jar = cookieJar();
    const { grantId, token } = await issue();
    await call('GET', { token, cookies: jar.api });
    const { revokeGrant } = await import('../../lib/edit-grants');
    await revokeGrant(ORG, SITE, grantId);
    expect((await call('PUT', { cookies: jar.api, body: { phone: '1' } })).status).toBe(401);
  });
});

describe('cross-origin use — no deploy required', () => {
  beforeEach(seed);

  it('echoes the site’s own origin, never a wildcard', async () => {
    // These responses are credentialed and carry the listing's contents, so
    // `*` would be wrong even if browsers allowed it here.
    const { token } = await issue();
    const mod = await import('../../pages/api/directory/[siteId]/session');
    const res = await mod.GET({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request(
        `https://app.typeroll.com/api/directory/${SITE}/session?t=${encodeURIComponent(token)}`,
        { headers: { origin: 'https://katalogen.se' } },
      ),
    } as never);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://katalogen.se');
  });

  it('refuses CORS to an origin that is not the site', async () => {
    const { token } = await issue();
    const mod = await import('../../pages/api/directory/[siteId]/session');
    const res = await mod.GET({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request(
        `https://app.typeroll.com/api/directory/${SITE}/session?t=${encodeURIComponent(token)}`,
        { headers: { origin: 'https://evil.example' } },
      ),
    } as never);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('hands back a session token that works as a bearer, with no cookie at all', async () => {
    // This is the whole point: the form on the customer's domain calls the
    // portal directly, so nothing has to be deployed first.
    const { token } = await issue();
    const mod = await import('../../pages/api/directory/[siteId]/session');
    const redeemed = await mod.GET({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request(`https://app.typeroll.com/x?t=${encodeURIComponent(token)}`),
    } as never);
    const { session_token } = await redeemed.json();
    expect(session_token).toBeTruthy();

    const res = await mod.PUT({
      params: { siteId: SITE }, cookies: cookieJar().api,   // empty jar
      request: new Request('https://app.typeroll.com/x', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${session_token}` },
        body: JSON.stringify({ phone: '031-000' }),
      }),
    } as never);
    expect(res.status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    const item = await vstore.collectionItem(ORG, SITE, 'main', 'companies', 'c1');
    expect((item as Record<string, unknown>).phone).toBe('031-000');
  });

  it('answers preflight', async () => {
    const mod = await import('../../pages/api/directory/[siteId]/session');
    const res = await mod.OPTIONS({
      params: { siteId: SITE },
      request: new Request('https://app.typeroll.com/x', {
        method: 'OPTIONS', headers: { origin: 'https://katalogen.se' },
      }),
    } as never);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('POST speaks the forms-runtime protocol', () => {
  beforeEach(seed);

  const post = async (fields: Record<string, string>, bearer: string) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const mod = await import('../../pages/api/directory/[siteId]/session');
    return mod.POST({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request('https://app.typeroll.com/x', {
        method: 'POST', body: fd, headers: { authorization: `Bearer ${bearer}` },
      }),
    } as never);
  };

  const bearer = async () => {
    const { token } = await issue();
    const mod = await import('../../pages/api/directory/[siteId]/session');
    const res = await mod.GET({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request(`https://app.typeroll.com/x?t=${encodeURIComponent(token)}`),
    } as never);
    return (await res.json()).session_token as string;
  };

  it('accepts FormData and answers {done:true}', async () => {
    // Exactly what forms-runtime.ts checks for, so a Typeroll form pointed
    // here renders its own success message with no special-casing.
    const res = await post({ phone: '070-999', _protocol: '1' }, await bearer());
    expect(await res.json()).toEqual({ done: true });
    const { vstore } = await import('../../lib/version-store');
    const item = await vstore.collectionItem(ORG, SITE, 'main', 'companies', 'c1');
    expect((item as Record<string, unknown>).phone).toBe('070-999');
  });

  it('reports a lost field as a PER-FIELD error the runtime can highlight', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.collectionItem(ORG, SITE, 'companies', 'c1'), {
      _provenance: { phone: { source: 'portal', actor: 'staff', updated_at: 'T' } },
    });
    const body = await (await post({ phone: '000' }, await bearer())).json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].field).toBe('phone');
  });

  it('swallows a honeypot hit as success, telling the bot nothing', async () => {
    const res = await post({ phone: '070-111', _hp: 'i am a bot' }, await bearer());
    expect(await res.json()).toEqual({ done: true });
    const { vstore } = await import('../../lib/version-store');
    const item = await vstore.collectionItem(ORG, SITE, 'main', 'companies', 'c1');
    expect((item as Record<string, unknown>).phone).toBe('070');  // unchanged
  });

  it('returns an expired session as a runtime error, not an HTTP failure', async () => {
    // The runtime only parses JSON on a 2xx; a bare 401 would surface as the
    // generic "something went wrong" instead of "your link expired".
    const res = await post({ phone: '1' }, 'garbage');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].message).toMatch(/session/i);
  });
});

describe('the app is resolved at BUILD time, not at submit', () => {
  // Answering "how does forms know to activate the app": it doesn't. The app
  // name is turned into a plain URL once, before the browser sees anything —
  // there is no dispatch, no registry lookup at runtime, and the form is an
  // ordinary form posting to an ordinary endpoint.
  it('turns target.app into a submit_url', async () => {
    const { resolveAppFormEndpoint } = await import('../../lib/apps/form-endpoint');
    expect(resolveAppFormEndpoint(
      { target: { app: 'directory', hydrate: true, session_param: 't' } },
      { siteId: 'acme', portalUrl: 'https://app.typeroll.com' },
    )).toEqual({
      submit_url: 'https://app.typeroll.com/api/directory/acme/session',
      submit_token: null,
      pow_bits: 0,
    });
  });

  it('leaves an ordinary form alone', async () => {
    const { resolveAppFormEndpoint } = await import('../../lib/apps/form-endpoint');
    expect(resolveAppFormEndpoint({}, { siteId: 'a', portalUrl: 'https://p' })).toBeNull();
  });

  it('falls back rather than emitting a form that posts nowhere', async () => {
    // An app that declares no formEndpoint (analytics) or one that doesn't
    // exist must not produce an action-less form.
    const { resolveAppFormEndpoint } = await import('../../lib/apps/form-endpoint');
    expect(resolveAppFormEndpoint({ target: { app: 'analytics' } }, { siteId: 'a', portalUrl: 'https://p' })).toBeNull();
    expect(resolveAppFormEndpoint({ target: { app: 'nope' } }, { siteId: 'a', portalUrl: 'https://p' })).toBeNull();
  });

  it('resolves even when the app is disabled', async () => {
    // Deliberate: the endpoint refuses with a message the visitor can act on.
    // Silently re-pointing at the submissions collector would make the edit
    // look accepted while landing somewhere nobody reads.
    const { resolveAppFormEndpoint } = await import('../../lib/apps/form-endpoint');
    expect(resolveAppFormEndpoint(
      { target: { app: 'directory' } }, { siteId: 'a', portalUrl: 'https://p' },
    )?.submit_url).toContain('/api/directory/a/session');
  });
});

describe('a visitor cannot reach another listing through the URL', () => {
  // The attack: hold a valid link to your own listing, then add a parameter
  // naming someone else's, and see whose values come back.
  beforeEach(seed);

  const withQuery = async (token: string, extra: string) => {
    const mod = await import('../../pages/api/directory/[siteId]/session');
    return mod.GET({
      params: { siteId: SITE }, cookies: cookieJar().api,
      request: new Request(
        `https://app.typeroll.com/api/directory/${SITE}/session?t=${encodeURIComponent(token)}&${extra}`,
      ),
    } as never);
  };

  it('ignores every id-shaped parameter', async () => {
    const { getStore } = await import('../../lib/datastore');
    // A second listing that must stay invisible.
    await getStore().setDoc(paths.collectionItem(ORG, SITE, 'companies', 'c2'), {
      status: 'published', created_at: 'x', updated_at: 'x',
      title: 'SECRET RIVAL', phone: '999', email: 'rival@example.com',
    });

    for (const param of ['item_id=c2', 'id=c2', 'listing=c2', 'listing_id=c2', 'collection=companies&item=c2']) {
      const { token } = await issue();                     // a link to c1
      const body = await (await withQuery(token, param)).json();
      expect(body.listing_id, param).toBe('c1');
      const title = body.fields.find((f: { name: string }) => f.name === 'title');
      expect(title.value, param).toBe('Acme');
      expect(JSON.stringify(body), param).not.toContain('SECRET RIVAL');
    }
  });

  it('reads only the signed token from the query string', async () => {
    // Belt and braces on the route itself: if a second parameter is ever
    // read, this catches it before the behaviour test above has to.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/pages/api/directory/[siteId]/session.ts', 'utf8');
    const reads = [...src.matchAll(/searchParams\.get\(([^)]*)\)/g)].map((m) => m[1]);
    for (const r of reads) {
      expect(["'t'", "'form'"], `unexpected query read: ${r}`).toContain(r);
    }
  });

  it('lets a prefill source fill an EMPTY field but never override the record', async () => {
    // A source resolves values; it never decides which record. So even a
    // source reading the query can only fill gaps on the listing the grant
    // already fixed.
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/pf`, {
      name: 'Edit', actions: [], created_at: 'x',
      prefill: [{ type: 'query', config: {} }],
      steps: [{ id: 's', blocks: [] }],
    });
    const { token } = await issue();
    const body = await (await withQuery(token, 'form=pf&title=OVERRIDE&phone=&x=1')).json();
    const byName = Object.fromEntries(
      body.fields.map((f: { name: string; value: unknown }) => [f.name, f.value]),
    );
    // title has a stored value → the record wins.
    expect(byName.title).toBe('Acme');
  });
});
