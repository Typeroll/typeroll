import { afterEach, expect, it, vi } from 'vitest';
import { paths, CORE_BLOCK_TYPES } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { answerRevision, submitOwnerProposal, decideOwnerProposal, reviewSettingsPath } from '../../lib/owner-proposals';
import { vstore } from '../../lib/version-store';
import { mergeWorkingCopy } from '../../lib/working-copy';
import { resolvePublicationVersion } from '../../lib/publishing/publication-version';
import { runBuildDerivations, stableDigest, derivationInputDigest } from '../../lib/publishing/build-derivation';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { publicationBuildHarness } from '../../../../../scripts/lib/publication-build-harness.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('publishes accepted No, clear, stable child rename and coverage together without proposal or import leakage', async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-review-test-not-a-credential');
  const scope = { orgId: 'synthetic', siteId: 'synthetic', versionId: 'main' };
  const store = getStore();
  const schema = { id: 'company', name: 'company', route_template: '/{slug}/', fields: [
    { name: 'support', type: 'object', label: 'Support', writable_by: ['owner', 'portal', 'agent', 'import'], fields: [
      { name: 'training', type: 'boolean' }, { name: 'catalog', type: 'boolean' },
    ] },
    { name: 'programs', type: 'array', label: 'Programs', writable_by: ['owner', 'portal', 'agent', 'import'], item_key: 'program_id', fields: [
      { name: 'program_id', type: 'text', writable_by: ['portal', 'agent'] }, { name: 'name', type: 'text' },
    ] },
    { name: 'scope', type: 'text', writable_by: ['owner', 'portal', 'agent', 'import'] },
    { name: 'regions', type: 'multiselect', options: ['east', 'west'], writable_by: ['owner', 'portal', 'agent', 'import'] },
    { name: 'private_note', type: 'text', rendered: false },
  ] };
  await store.setDoc(paths.contentType(scope.orgId, scope.siteId, 'company'), schema);
  const pagePath = paths.page(scope.orgId, scope.siteId, 'company');
  await store.setDoc(pagePath, { title: 'Company', slug: 'company', content_type: 'company', status: 'published', content_mode: 'blocks',
    blocks: [{ id: 'title', type: 'core/heading', data: { text: 'Company', level: 'h1' } }], fields: {
      support: { training: true, catalog: true }, programs: [{ program_id: 'stable-program', name: 'Original program' }],
      scope: 'listed', regions: ['east'], private_note: 'PRIVATE-SENTINEL',
    } });
  await store.setDoc(paths.settings(scope.orgId, scope.siteId), { site_name: 'Synthetic', trailing_slash: 'always' });
  await store.setDoc(reviewSettingsPath(scope), { recipient: 'reviewer@example.test', enabled: true, link_ttl_hours: 24 });
  await store.setDoc(paths.page(scope.orgId, scope.siteId, 'home'), { title: 'Home', slug: '', status: 'published', content_mode: 'html', html_content: '<h1>Home</h1>' });
  const original = await store.getDoc<any>(pagePath);
  const submit = await submitOwnerProposal(scope, 'company', { installationId: 'synthetic-app', subjectId: 'a'.repeat(64) }, {
    request_id: 'synthetic-proposal-0001', base_revision: answerRevision(original), changes: {
      support: { training: false, catalog: null }, programs: [{ program_id: 'stable-program', name: 'Renamed program' }], regions: ['west'],
    },
  });
  const freeze = async () => {
    const resolved = await resolvePublicationVersion(scope.orgId, scope.siteId, scope.versionId);
    return projectStaticPublication({ ...resolved, site: { name: 'Synthetic' }, media: [], forms: [], extensions: [] }, {
      siteUrl: 'https://example.test', coreCommit: 'a'.repeat(40), publishedAt: '2026-10-23T00:00:00Z', noindex: false, coreBlockTypes: CORE_BLOCK_TYPES,
    });
  };
  expect((await freeze()).pages[0].fields.support.training).toBe(true);
  const decision = { action: 'approve' as const, request_id: 'synthetic-decision-0001' };
  await decideOwnerProposal(scope, submit.proposal_id, { adminId: 'synthetic-reviewer' }, decision);
  await decideOwnerProposal(scope, submit.proposal_id, { adminId: 'synthetic-reviewer' }, decision);
  await mergeWorkingCopy(scope, { kind: 'page', id: 'company' }, { title: 'WORKING-SENTINEL', fields: { support: { training: true } } }, 'synthetic-editor');
  const frozen: any = await freeze();
  expect(JSON.stringify(frozen)).not.toContain('WORKING-SENTINEL');
  expect(JSON.stringify(frozen)).not.toContain('PRIVATE-SENTINEL');
  expect(JSON.stringify(frozen)).not.toContain('_provenance');
  expect(frozen.pages[0].fields).toMatchObject({ support: { training: false, catalog: null }, regions: ['west'] });
  await expect(vstore.writePage(scope.orgId, scope.siteId, 'main', 'company', { fields: original.fields }, {
    actor: 'import', actorId: 'stale-import',
  })).rejects.toThrow('higher-precedence');
  expect((await freeze()).pages).toEqual(frozen.pages);

  // A generic provider here keeps application rules out of public Core. Private
  // app qualification can inject an adapter for the identical frozen contract.
  const adapterPath = process.env.TYPEROLL_DERIVATION_TEST_ADAPTER;
  const external = adapterPath ? await import(/* @vite-ignore */ adapterPath) : null;
  const request = async (input: any) => {
    const fields = input.content.pages[0].fields;
    return { input_digest: derivationInputDigest(input), receipts: [{ kind: 'records', id: 'company', count: 1 }], sources: [
      { id: 'example.facts', records: [{ id: 'company', text: `training:${fields.support.training};catalog:${fields.support.catalog}` }] },
      { id: 'example.programs', records: fields.programs.map((p: any) => ({ id: p.program_id, text: p.name })) },
      { id: 'example.memberships', records: [{ id: 'training', text: `count:${fields.support.training === true ? 1 : 0}` }] },
      { id: 'example.coverage', records: [{ id: 'region', text: fields.regions.join(',') }] },
    ] };
  };
  const content = { version_id: 'main', pages: frozen.pages, content_types: frozen.contentTypes };
  const result = await runBuildDerivations({ org_id: scope.orgId, site_id: scope.siteId, version_id: 'main', provider_version: '',
    content, content_digest: stableDigest(content), config_digest: stableDigest({}) }, [external?.provider ?? { id: 'synthetic-provider', version: '1.0.0', required: true, config: {}, request }]);
  frozen.derived = Object.fromEntries(result.sources.map(source => [source.id, source.records]));
  const consumers = external?.consumers ?? result.sources.map(source => ({ source: source.id, template: '<p>{{item.text}}</p>' }));
  frozen.blockTypes = consumers.map((consumer: any, i: number) => ({ id: `synthetic-output-${i}`, label: 'Derived output', schema: [], template: consumer.template }));
  frozen.pages[0].blocks.push(...consumers.map((consumer: any, i: number) => ({ id: `derived-${i}`, type: 'core/repeater', data: {
    source_type: 'derived', derived_source: consumer.source, item_block: `synthetic-output-${i}`,
  } })));
  frozen.blockTypes.push({ id: 'synthetic-dataset', label: 'Public dataset', schema: [], template: '<div data-dataset="{{site.derived_data_url}}"></div>' });
  frozen.pages[0].blocks.push({ id: 'data-url', type: 'synthetic-dataset', data: {} });
  const harness = await publicationBuildHarness(frozen);
  try {
    const run = await harness.run();
    expect(run.report.rendered).toBe(2);
    const html = await readFile(join(harness.destination, 'dist/company/index.html'), 'utf8');
    for (const value of external?.expectedText ?? ['training:false;catalog:null', 'Renamed program', 'count:0', 'west']) expect(html).toContain(value);
    const dataUrl = html.match(/data-dataset="([^"]+)"/)?.[1];
    expect(dataUrl).toMatch(/^\/_typeroll\/derived\/[a-f0-9]{64}\.json$/);
    const dataset = JSON.parse(await readFile(join(harness.destination, 'dist', dataUrl!), 'utf8'));
    expect(dataset).toEqual(frozen.derived);
    for (const value of ['PRIVATE-SENTINEL', 'Original program', 'training:true', '_provenance']) expect(html).not.toContain(value);
  } finally { await harness.cleanup(); }
}, 120_000);
