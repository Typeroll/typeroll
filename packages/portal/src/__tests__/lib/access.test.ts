import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';

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
