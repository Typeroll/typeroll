/**
 * Coalesced auto-deploy.
 *
 * The behaviour that matters: an agent writing forty records produces ONE
 * build, and a site that never opted in keeps deploying only when a human
 * presses the button.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { DEFAULT_DEBOUNCE_MINUTES, isDeployDue } from '../../lib/auto-deploy';

const site = (over: Partial<Site>): Site =>
  ({ id: 's', name: 'S', hosting_adapter: 'cloudflare', ...over }) as Site;

const minutesAgo = (n: number, from = Date.now()) => new Date(from - n * 60_000).toISOString();

describe('isDeployDue', () => {
  it('is false when the site never opted in, however old the marker', () => {
    // The whole safety property: enabling this platform-wide must not make
    // existing sites start deploying on their own.
    const s = site({ pending_deploy_at: minutesAgo(600) });
    expect(isDeployDue(s)).toBe(false);
  });

  it('is false with no pending edits', () => {
    expect(isDeployDue(site({ auto_deploy: { enabled: true } }))).toBe(false);
  });

  it('is false while the debounce window is still open', () => {
    const s = site({ auto_deploy: { enabled: true }, pending_deploy_at: minutesAgo(5) });
    expect(isDeployDue(s)).toBe(false);
  });

  it('fires once the oldest pending edit ages past the window', () => {
    const s = site({
      auto_deploy: { enabled: true },
      pending_deploy_at: minutesAgo(DEFAULT_DEBOUNCE_MINUTES + 1),
    });
    expect(isDeployDue(s)).toBe(true);
  });

  it('honours a per-site window', () => {
    const s = site({
      auto_deploy: { enabled: true, debounce_minutes: 60 },
      pending_deploy_at: minutesAgo(30),
    });
    expect(isDeployDue(s)).toBe(false);
    expect(isDeployDue(s, new Date(Date.now() + 31 * 60_000))).toBe(true);
  });

  it('ignores a corrupt marker instead of deploying in a loop', () => {
    const s = site({ auto_deploy: { enabled: true }, pending_deploy_at: 'not-a-date' });
    expect(isDeployDue(s)).toBe(false);
  });
});

describe('markSiteDirty', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  const read = async () => {
    const { getStore } = await import('../../lib/datastore');
    return getStore().getDoc<Site>(paths.site('default', 'mysite'));
  };
  const seed = async (over: Partial<Site>) => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare', ...over,
    });
  };

  it('does nothing on a site that has not opted in', async () => {
    await seed({});
    const { markSiteDirty } = await import('../../lib/auto-deploy');
    await markSiteDirty('default', 'mysite');
    expect((await read())?.pending_deploy_at).toBeUndefined();
  });

  it('stamps the marker on the first write', async () => {
    await seed({ auto_deploy: { enabled: true } });
    const { markSiteDirty } = await import('../../lib/auto-deploy');
    await markSiteDirty('default', 'mysite');
    expect(typeof (await read())?.pending_deploy_at).toBe('string');
  });

  it('does NOT refresh the marker on later writes', async () => {
    // The value is the age of the OLDEST pending edit. Refreshing it would
    // let a steady trickle of writes postpone the build forever — the exact
    // failure mode a debounce is supposed to avoid.
    await seed({ auto_deploy: { enabled: true }, pending_deploy_at: minutesAgo(30) });
    const before = (await read())?.pending_deploy_at;
    const { markSiteDirty } = await import('../../lib/auto-deploy');
    await markSiteDirty('default', 'mysite');
    expect((await read())?.pending_deploy_at).toBe(before);
  });

  it('survives a missing site rather than throwing into the caller', async () => {
    // Called from commit paths whose real job is saving content; a failure
    // here must never fail the save.
    const { markSiteDirty } = await import('../../lib/auto-deploy');
    await expect(markSiteDirty('default', 'nope')).resolves.toBeUndefined();
  });
});

describe('the publish sweep coalesces pending edits into one build', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('enqueues one deploy for a dirty site and clears its marker', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.org('default'), { name: 'D', slug: 'default', plan: 'free', created_at: 'x' });
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
      auto_deploy: { enabled: true },
      pending_deploy_at: minutesAgo(60),
    });

    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep();

    expect(result.auto_deployed).toEqual(['default/mysite']);
    expect(result.deployed).toEqual(['default/mysite']);
    // Cleared on ENQUEUE — a write landing mid-build re-stamps it and gets
    // picked up next sweep, whereas clearing on completion would swallow it.
    const after = await store.getDoc<Site>(paths.site('default', 'mysite'));
    expect(after?.pending_deploy_at).toBeNull();
  });

  it('skips a site that is already building and KEEPS its dirty marker', async () => {
    // The marker is what brings the sweep back. Clearing it here — which the
    // enqueue path does, one line below the skip — would drop exactly the
    // edits that made the site dirty, and nothing would ever rebuild them.
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.org('default'), { name: 'D', slug: 'default', plan: 'free', created_at: 'x' });
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
      auto_deploy: { enabled: true },
      pending_deploy_at: minutesAgo(60),
    });
    await store.setDoc(paths.deploy('default', 'mysite', 'running1'), {
      version_id: MAIN_VERSION_ID, environment: 'production',
      status: 'running', started_at: minutesAgo(2),
    });

    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep();

    expect(result.deployed).toEqual([]);
    expect(result.skipped_in_flight).toEqual(['default/mysite']);
    const after = await store.getDoc<Site>(paths.site('default', 'mysite'));
    expect(after?.pending_deploy_at).not.toBeNull();
  });

  it('deploys a dirty site whose last build died mid-flight', async () => {
    // A stale `running` job must not wedge auto-deploy forever.
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.org('default'), { name: 'D', slug: 'default', plan: 'free', created_at: 'x' });
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
      auto_deploy: { enabled: true },
      pending_deploy_at: minutesAgo(60),
    });
    await store.setDoc(paths.deploy('default', 'mysite', 'zombie'), {
      version_id: MAIN_VERSION_ID, environment: 'production',
      status: 'running', started_at: minutesAgo(90),
    });

    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep();

    expect(result.deployed).toEqual(['default/mysite']);
    expect(result.skipped_in_flight).toEqual([]);
  });

  it('leaves a site alone while its window is still open', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.org('default'), { name: 'D', slug: 'default', plan: 'free', created_at: 'x' });
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
      auto_deploy: { enabled: true },
      pending_deploy_at: minutesAgo(2),
    });

    const { runPublishSweep } = await import('../../lib/scheduled-publish');
    const result = await runPublishSweep();
    expect(result.deployed).toEqual([]);
    const after = await store.getDoc<Site>(paths.site('default', 'mysite'));
    expect(after?.pending_deploy_at).not.toBeNull();
  });
});
