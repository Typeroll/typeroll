// Migration preflight. Each blocker here exists because its failure mode is
// SILENT — the migration reports success and something is quietly wrong — so
// the tests pin both the detection and the refusal to start.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Form, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const R2_ENV = {
  R2_ACCOUNT_ID: 'acc',
  R2_BUCKET: 'bucket',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
};
const CF_ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CLOUDFLARE_PAGES_PROJECT: 'proj',
};

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
function clearEnv(...keys: string[]): void {
  for (const k of keys) delete process.env[k];
}

async function seedSite(site: Partial<Site> = {}): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(), hosting_adapter: 'cloudflare', ...site,
  });
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function run() {
  const { runMigrationPreflight } = await import('../../lib/migration-preflight');
  return runMigrationPreflight(ORG, SITE, MAIN_VERSION_ID);
}

function check(report: Awaited<ReturnType<typeof run>>, id: string) {
  return report.checks.find((c) => c.id === id);
}

describe('runMigrationPreflight', () => {
  beforeEach(async () => {
    clearEnv(...Object.keys(R2_ENV), ...Object.keys(CF_ENV), 'ANTHROPIC_API_KEY', 'SITES_BASE_DOMAIN');
    await seedSite();
  });
  afterEach(() => {
    clearEnv(...Object.keys(R2_ENV), ...Object.keys(CF_ENV), 'ANTHROPIC_API_KEY', 'SITES_BASE_DOMAIN');
  });

  it('blocks when media storage is unconfigured — the silent-failure case', async () => {
    setEnv(CF_ENV);
    const report = await run();
    expect(report.ready).toBe(false);
    const media = check(report, 'media_storage');
    expect(media?.status).toBe('fail');
    expect(media?.severity).toBe('blocker');
    // The reason has to say what goes wrong LATER, not just "not configured".
    expect(media?.detail).toContain('old host');
    expect(media?.fix).toContain('R2_ACCOUNT_ID');
  });

  it('blocks when deploys would run against the stub adapter', async () => {
    setEnv(R2_ENV);
    const report = await run();
    expect(report.ready).toBe(false);
    expect(check(report, 'hosting')?.status).toBe('fail');
    expect(check(report, 'hosting')?.detail).toContain('publishes nothing');
  });

  it('is ready once both blockers are satisfied', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    const report = await run();
    expect(report.ready).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('warns — but does not block — when there is no verification origin', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    const report = await run();
    expect(report.ready).toBe(true);
    expect(check(report, 'verification_origin')?.status).toBe('fail');
    expect(check(report, 'verification_origin')?.severity).toBe('warning');
  });

  it('passes the verification-origin check once the site has a fallback URL', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV, SITES_BASE_DOMAIN: 'sites.example.com' });
    await seedSite({ slug: 'acme' });
    const report = await run();
    expect(check(report, 'verification_origin')?.status).toBe('ok');
    expect(check(report, 'verification_origin')?.detail).toContain('acme.sites.example.com');
  });

  it('only checks form email once the site actually has a form', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    expect(check(await run(), 'forms_email')).toBeUndefined();

    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
      name: 'Kontakt', created_at: new Date().toISOString(),
    } satisfies Partial<Form>);
    const withForm = await run();
    expect(check(withForm, 'forms_email')?.status).toBe('fail');
    expect(check(withForm, 'forms_email')?.detail).toContain('nobody is notified');
  });

  it('passes form email when a connector is configured', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
      name: 'Kontakt', created_at: new Date().toISOString(),
    } satisfies Partial<Form>);
    await getStore().setDoc(paths.integrations(ORG, SITE), {
      email: { type: 'postmark' },
    });
    expect(check(await run(), 'forms_email')?.status).toBe('ok');
  });

  it('warns when the target has no design to rebuild into', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    expect(check(await run(), 'design_reference')?.status).toBe('fail');

    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/header`, {
      name: 'header', kind: 'header', status: 'published', content_mode: 'html', html_content: '<nav></nav>',
    });
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'html', html_content: '',
    });
    expect(check(await run(), 'design_reference')?.status).toBe('ok');
  });
});

describe('source-site probe', () => {
  beforeEach(async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    await seedSite();
  });
  afterEach(() => clearEnv(...Object.keys(R2_ENV), ...Object.keys(CF_ENV)));

  function fakeFetch(routes: Record<string, { status: number; contentType?: string } | Error>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const hit = routes[url];
      if (!hit) throw new Error(`unexpected fetch: ${url}`);
      if (hit instanceof Error) throw hit;
      return new Response(null, {
        status: hit.status,
        headers: hit.contentType ? { 'content-type': hit.contentType } : undefined,
      });
    }) as unknown as typeof fetch;
  }

  async function runWithSource(sourceUrl: string, fetchImpl: typeof fetch) {
    const { runMigrationPreflight } = await import('../../lib/migration-preflight');
    return runMigrationPreflight(ORG, SITE, MAIN_VERSION_ID, { sourceUrl, fetchImpl });
  }

  it('is skipped entirely when no source is named', async () => {
    const report = await run();
    expect(check(report, 'source_reachable')).toBeUndefined();
    expect(check(report, 'source_wp_rest')).toBeUndefined();
  });

  it('passes when the source answers and exposes /wp-json', async () => {
    const report = await runWithSource('https://old.example.com', fakeFetch({
      'https://old.example.com': { status: 200 },
      'https://old.example.com/wp-json': { status: 200, contentType: 'application/json' },
    }));
    expect(report.ready).toBe(true);
    expect(check(report, 'source_reachable')?.status).toBe('ok');
    expect(check(report, 'source_wp_rest')?.status).toBe('ok');
  });

  it('BLOCKS when the source is unreachable', async () => {
    const report = await runWithSource('https://old.example.com', fakeFetch({
      'https://old.example.com': new Error('ENOTFOUND'),
    }));
    expect(report.ready).toBe(false);
    expect(check(report, 'source_reachable')?.detail).toContain('ENOTFOUND');
  });

  it('BLOCKS on a bot-block, and says so — a scraped block page reads as content', async () => {
    const report = await runWithSource('https://old.example.com', fakeFetch({
      'https://old.example.com': { status: 403 },
    }));
    expect(report.ready).toBe(false);
    const c = check(report, 'source_reachable');
    expect(c?.detail).toContain('refusing our requests');
    expect(c?.fix).toContain('allowlist');
  });

  it('only WARNS when the source is up but has no WP REST — scraping still works', async () => {
    const report = await runWithSource('https://squarespace-ish.example.com', fakeFetch({
      'https://squarespace-ish.example.com': { status: 200 },
      'https://squarespace-ish.example.com/wp-json': { status: 404 },
    }));
    expect(report.ready).toBe(true);
    const c = check(report, 'source_wp_rest');
    expect(c?.severity).toBe('warning');
    expect(c?.detail).toContain('scraping public HTML');
  });

  it('treats an HTML response from /wp-json as unavailable, not as a working API', async () => {
    // A WP install with REST disabled often serves the themed 404 page with
    // status 200 — content-type is what distinguishes it.
    const report = await runWithSource('https://old.example.com', fakeFetch({
      'https://old.example.com': { status: 200 },
      'https://old.example.com/wp-json': { status: 200, contentType: 'text/html' },
    }));
    expect(check(report, 'source_wp_rest')?.status).toBe('fail');
  });

  it('rejects a source that is not a usable URL', async () => {
    const report = await runWithSource('not a url', fakeFetch({}));
    expect(report.ready).toBe(false);
    expect(check(report, 'source_reachable')?.fix).toContain('absolute URL');
  });

  it('accepts a bare hostname and follows a path to its origin', async () => {
    const report = await runWithSource('old.example.com/nagon/sida', fakeFetch({
      'https://old.example.com': { status: 200 },
      'https://old.example.com/wp-json': { status: 200, contentType: 'application/json' },
    }));
    expect(check(report, 'source_reachable')?.status).toBe('ok');
  });
});

describe('migration workflow gate', () => {
  beforeEach(async () => {
    clearEnv(...Object.keys(R2_ENV), ...Object.keys(CF_ENV));
    await seedSite();
  });
  afterEach(() => clearEnv(...Object.keys(R2_ENV), ...Object.keys(CF_ENV)));

  async function runPreflightStep(config: Record<string, unknown>) {
    const { migrationWorkflow } = await import('../../lib/workflows/migration');
    const { getStore } = await import('../../lib/datastore');
    const step = migrationWorkflow.steps[0];
    const logs: string[] = [];
    return {
      step,
      logs,
      result: step.run({
        orgId: ORG, siteId: SITE, workflowId: 'wf', config, state: {},
        store: getStore(), log: (m: string) => logs.push(m), setProgress: () => {},
      }),
    };
  }

  it('is the FIRST step — a blocker found later means redoing the content work', async () => {
    const { migrationWorkflow } = await import('../../lib/workflows/migration');
    expect(migrationWorkflow.steps[0].name).toBe('preflight');
  });

  it('refuses to start when a blocker stands', async () => {
    const { result } = await runPreflightStep({ wp_url: 'https://old.example.com' });
    await expect(result).rejects.toThrow(/Migration not started/);
  });

  it('proceeds — loudly — when the operator overrides', async () => {
    const { result, logs } = await runPreflightStep({
      wp_url: 'https://old.example.com', skip_preflight: true,
    });
    await expect(result).resolves.toBeTruthy();
    expect(logs.some((l) => l.startsWith('OVERRIDE:'))).toBe(true);
  });

  it('runs clean when the platform is configured', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    const { result } = await runPreflightStep({});
    const out = await result;
    expect((out as { results: { preflight: { ready: boolean } } }).results.preflight.ready).toBe(true);
  });

  it('probes the configured wp_url — the source check is not agent-only', async () => {
    setEnv({ ...R2_ENV, ...CF_ENV });
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const { result } = await runPreflightStep({ wp_url: 'https://old.example.com' });
      await result;
      expect(seen).toContain('https://old.example.com');
      expect(seen).toContain('https://old.example.com/wp-json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
