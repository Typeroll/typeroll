import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { captureImpact, compareImpact } from '../../lib/publishing/impact';
import { attributeConfigurationChanges } from '../../lib/publishing/impact-attribution';

const since = '2026-11-10T00:00:00.000Z';
const publication = (endpoint: string, version: string, analytics: boolean) => ({ version_id: 'main', core_commit: 'a', pages: [], settings: {}, apps: { analytics },
  runtime_dependencies: [{ kind: 'forms', id: 'contact', endpoint }, { kind: 'extension', id: 'se.example.engine', version }],
  extensions: { installations: [{ extension_id: 'se.example.engine', version }] } });

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('says which records changed a configuration entry after the baseline, without request bodies or addresses of people', async () => {
  const store = getStore();
  await store.setDoc(paths.apps('org', 'site'), { apps: {}, updated_at: '2026-11-12T08:00:00.000Z' });
  await store.addDoc(paths.extensionAudit('org', 'site'), { extension_id: 'se.example.engine', site_id: 'site', action: 'installation_config_updated', actor_id: 'user-1', created_at: '2026-11-13T09:00:00.000Z' });
  await store.addDoc(paths.extensionAudit('org', 'site'), { extension_id: 'se.example.engine', site_id: 'site', action: 'installed', actor_id: 'user-0', created_at: '2026-11-01T09:00:00.000Z' });
  await store.addDoc(paths.apiAudit('org', 'site'), { key_prefix: 'tr_abc', method: 'PATCH', path: '/api/v1/sites/site/apps/analytics', status: 200, ip: '203.0.113.9', ts: '2026-11-14T10:00:00.000Z', body_preview: '{"enabled":false}' });
  await store.addDoc(paths.apiAudit('org', 'site'), { key_prefix: 'tr_abc', method: 'PATCH', path: '/api/v1/sites/site/pages/home', status: 200, ts: '2026-11-14T11:00:00.000Z' });
  const impact = compareImpact(captureImpact(publication('https://forms.old.example/a', '0.2.11', true), 'org', 'site'), captureImpact(publication('https://forms.new.example/a', '0.2.12', false), 'org', 'site'));
  await attributeConfigurationChanges('org', 'site', since, impact);
  const apps = impact.changes.find(change => change.id === 'apps')!;
  expect(apps.changed_by).toEqual([
    { source: 'api', at: '2026-11-14T10:00:00.000Z', action: 'PATCH', route: '/api/v1/sites/site/apps/analytics', summary: 'PATCH /api/v1/sites/site/apps/analytics through an API key (tr_abc).' },
    { source: 'apps', at: '2026-11-12T08:00:00.000Z', summary: 'The site’s apps were changed.' },
  ]);
  const runtime = impact.changes.find(change => change.id === 'runtime_dependencies')!;
  expect(runtime.changed_by?.map(source => source.source)).toEqual(['api', 'extension_audit', 'apps', 'platform']);
  expect(runtime.changed_by?.find(source => source.source === 'extension_audit')).toMatchObject({ actor_id: 'user-1', action: 'installation_config_updated' });
  expect(JSON.stringify(impact)).not.toMatch(/203\.0\.113\.9|enabled":false/);
});

it('adds nothing without a baseline time or changed configuration', async () => {
  const same = captureImpact(publication('https://forms.example/a', '0.2.11', true), 'org', 'site');
  const impact = compareImpact(same, same);
  await attributeConfigurationChanges('org', 'site', since, impact);
  await attributeConfigurationChanges('org', 'site', null, impact);
  expect(impact.changes).toEqual([]);
});
