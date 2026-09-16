import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { APP_DOCUMENTATION, siteAppDocumentation } from '../../lib/apps/documentation';
import { listAppDefs } from '../../lib/apps/registry';
import { getStore } from '../../lib/datastore';

vi.mock('../../lib/extensions/resolution', () => ({ resolveExtensionVersion: vi.fn(async (installation: { id: string }) => ({ version: installation.id === 'unavailable' ? null : {
  version: '1.2.3', manifest: { name: 'Example', ...(installation.id === 'documented' ? { documentation: { url: 'https://provider.example/docs/', agent_instructions: 'Provider reference' } } : {}) },
} })) }));

describe('site app documentation', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
  it('covers every registered module with an embedded public guide', () => {
    expect(Object.keys(APP_DOCUMENTATION).sort()).toEqual(listAppDefs().map(app => app.id).sort());
    for (const guide of Object.values(APP_DOCUMENTATION)) {
      expect(guide.content).toContain('title:');
      expect(guide.content.length).toBeGreaterThan(200);
    }
  });
  it('scopes discovery to enabled modules and returns no stored config', async () => {
    await getStore().setDoc(paths.apps('org', 'one'), { apps: { directory: { enabled: true, config: { secret: 'must-not-leak' } }, analytics: { enabled: false } } });
    await getStore().setDoc(paths.apps('other-org', 'one'), { apps: { analytics: { enabled: true } } });
    const result = await siteAppDocumentation('org', 'one');
    expect(result.apps.map(app => app.id)).toEqual(['directory']);
    expect(result.apps[0].documentation_markdown).toContain('Resumable census imports');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect((await siteAppDocumentation('org', 'two')).apps).toEqual([]);
  });
  it('reports missing provider docs and unavailable releases explicitly and omits disabled installations', async () => {
    for (const id of ['documented', 'missing', 'unavailable', 'disabled']) await getStore().setDoc(paths.extensionInstallations('org', 'site') + '/' + id, { id, extension_id: 'example.' + id, status: id === 'disabled' ? 'disabled' : 'enabled', encrypted_config: 'must-not-leak' });
    const result = await siteAppDocumentation('org', 'site');
    expect(result.extensions).toHaveLength(3);
    expect(result.extensions.find(item => item.installation_id === 'documented')).toMatchObject({ version: '1.2.3', documentation_status: 'available', instructions_source: 'extension_provider' });
    expect(result.extensions.find(item => item.installation_id === 'missing')?.documentation_status).toBe('not_provided');
    expect(result.extensions.find(item => item.installation_id === 'unavailable')?.documentation_status).toBe('release_unavailable');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
});
