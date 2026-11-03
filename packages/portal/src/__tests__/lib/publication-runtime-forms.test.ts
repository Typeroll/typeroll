import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
vi.mock('../../lib/extensions/runtime-snapshot', () => ({ buildExtensionRuntimeSnapshot: async () => ({ installations: [] }) }));
vi.mock('../../lib/apps/form-endpoint', () => ({ resolveAppFormEndpoint: async () => null }));
vi.mock('../../lib/forms-signing', () => ({ POW_BITS: 15, formEmbedInfo: (_org: string, _site: string, id: string) => ({ submit_url: 'https://forms.example.invalid/api/forms/submit', token: `token-${id}` }) }));
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('publishes which form fields load live choices, without their source configuration', async () => {
  const { publicationRuntime } = await import('../../lib/publishing/runtime-projection');
  const steps = [{ id: 'main', fields: [{ type: 'radio', name: 'occurrence', label: 'When?', options: ['Loading…'], required: true }] }];
  await getStore().setDoc(`${paths.forms('org', 'site')}/live`, { name: 'Live', steps,
    option_sources: [{ field: 'occurrence', type: 'extension:inst_1:open-occurrences', config: { series_id: 'private-series' }, notice_field: 'notice_version' }] });
  await getStore().setDoc(`${paths.forms('org', 'site')}/plain`, { name: 'Plain', steps });
  const { forms } = await publicationRuntime('org', 'site');
  const live = forms.find(form => form.id === 'live')!, plain = forms.find(form => form.id === 'plain')!;
  expect(live).toMatchObject({ option_sources: [{ field: 'occurrence' }] });
  expect(JSON.stringify(live)).not.toContain('private-series');
  expect(JSON.stringify(live)).not.toContain('inst_1');
  expect(plain).not.toHaveProperty('option_sources');
});
