import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';

// The advisory cookie path. It keeps the fallback on purpose — the
// typeroll_version cookie is site-agnostic, so a branch of one site
// legitimately reaches a sibling that never had it.
describe('resolveVersionId', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('returns main for unset/empty input', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveVersionId } = await import('../../lib/access');
    expect(await resolveVersionId('o', 's', undefined)).toBe(MAIN_VERSION_ID);
    expect(await resolveVersionId('o', 's', '')).toBe(MAIN_VERSION_ID);
  });

  it('rejects ids that fail the allowlist regex', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveVersionId } = await import('../../lib/access');
    // path-traversal attempts
    expect(await resolveVersionId('o', 's', '../etc/passwd')).toBe(MAIN_VERSION_ID);
    expect(await resolveVersionId('o', 's', 'with spaces')).toBe(MAIN_VERSION_ID);
    expect(await resolveVersionId('o', 's', 'UPPERCASE')).toBe(MAIN_VERSION_ID);
  });

  it('returns main when the version doc does not exist', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveVersionId } = await import('../../lib/access');
    expect(await resolveVersionId('o', 's', 'no-such-branch')).toBe(MAIN_VERSION_ID);
  });

  it('returns the id when the version doc exists', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version('o', 's', 'feature'), {
      name: 'feature', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(),
    });
    const { resolveVersionId } = await import('../../lib/access');
    expect(await resolveVersionId('o', 's', 'feature')).toBe('feature');
  });
});

describe('resolveRequestedVersion', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('resolves unset, empty and an explicit main to main', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveRequestedVersion } = await import('../../lib/access');
    expect(await resolveRequestedVersion('o', 's', undefined))
      .toEqual({ ok: true, versionId: MAIN_VERSION_ID });
    expect(await resolveRequestedVersion('o', 's', ''))
      .toEqual({ ok: true, versionId: MAIN_VERSION_ID });
    expect(await resolveRequestedVersion('o', 's', null))
      .toEqual({ ok: true, versionId: MAIN_VERSION_ID });
    expect(await resolveRequestedVersion('o', 's', MAIN_VERSION_ID))
      .toEqual({ ok: true, versionId: MAIN_VERSION_ID });
  });

  // The M40.1 control: well-formed, passes the allowlist, was never created.
  it('refuses a fabricated version rather than answering about main', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveRequestedVersion } = await import('../../lib/access');
    expect(await resolveRequestedVersion('o', 's', 'definitely-not-a-version'))
      .toEqual({ ok: false, requested: 'definitely-not-a-version' });
  });

  it('refuses ids that fail the allowlist regex', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { resolveRequestedVersion } = await import('../../lib/access');
    for (const bad of ['../etc/passwd', 'with spaces', 'UPPERCASE']) {
      expect(await resolveRequestedVersion('o', 's', bad)).toEqual({ ok: false, requested: bad });
    }
  });

  it('resolves a version that exists', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version('o', 's', 'feature'), {
      name: 'feature', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(),
    });
    const { resolveRequestedVersion } = await import('../../lib/access');
    expect(await resolveRequestedVersion('o', 's', 'feature'))
      .toEqual({ ok: true, versionId: 'feature' });
  });

  it('names the version in the refusal body', async () => {
    const { unknownVersionResponse } = await import('../../lib/access');
    const response = unknownVersionResponse('definitely-not-a-version');
    expect(response.status).toBe(404);
    expect(await response.json())
      .toEqual({ error: 'Unknown version "definitely-not-a-version"' });
  });
});
