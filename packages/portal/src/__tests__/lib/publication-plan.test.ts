import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';

const mocks = vi.hoisted(() => ({ outlook: vi.fn(), impact: vi.fn(), targets: vi.fn(), activity: vi.fn(), unsaved: vi.fn() }));
vi.mock('../../lib/publishing/build-outlook', () => ({ publicationBuildOutlook: mocks.outlook }));
vi.mock('../../lib/publishing/impact-preview', () => ({ previewPublicationImpact: mocks.impact }));
vi.mock('../../lib/publishing/publication-targets', () => ({ publicationTargets: mocks.targets }));
vi.mock('../../lib/builds/activity', () => ({ buildActivity: mocks.activity }));
vi.mock('../../lib/deploy/unsaved', () => ({ unsavedPublicationTargets: mocks.unsaved }));
const { publicationPlan } = await import('../../lib/publishing/publication-plan');

const engine = { provider: 'cloudflare', node_version: '22.23.1', required_node_version: '22.23.5', update_reason: 'capability_missing', auto_update: false, blocks_publication: true };
const impact = (classification: string, changes: any[] = []) => ({ comparison: 'verified_snapshot', classification, total: changes.length, changes, platform_changes: [] });
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocks.outlook.mockResolvedValue({ would_fail: false, blockers: [], notes: [], build_engine: { ...engine, node_version: '22.23.5', update_reason: null, blocks_publication: false } });
  mocks.impact.mockResolvedValue(impact('page_content_only', [{ kind: 'page', id: 'home', action: 'changed', fields: ['blocks'] }]));
  mocks.targets.mockResolvedValue({ production: false, live_domains: [], targets: ['https://site-1.sites.example.com'] });
  mocks.activity.mockResolvedValue({ active_jobs: [], awaiting_approval: [] });
  mocks.unsaved.mockResolvedValue([]);
});

it('is ready with one step when nothing blocks or slows the publication', async () => {
  expect(await publicationPlan('org', 'site', 'main')).toMatchObject({ verdict: 'ready', blockers: [], notes: [], steps: [{ code: 'publish', tool: 'trigger_deploy' }], estimate: null });
});

// autopilot-sverige-ab-4 (2026-11-16): a new Core needing Node.js 22.23.4+, an engine on 22.23.1, two unexplained configuration changes and a live domain.
it('blocks on the engine and lists every step left, in order', async () => {
  mocks.outlook.mockResolvedValue({ would_fail: true, blockers: [{ code: 'build_engine_update_required', message: 'The build engine runs Node.js 22.23.1; this Typeroll builds with Node.js 22.23.5.', settings_url: '/x' }], notes: [], build_engine: engine });
  mocks.impact.mockResolvedValue(impact('site_wide', [{ kind: 'page', id: 'event', action: 'changed', fields: ['blocks'] }, { kind: 'configuration', id: 'extensions', action: 'changed', fields: ['value'] }]));
  mocks.targets.mockResolvedValue({ production: true, live_domains: ['https://www.example.se'], targets: ['https://www.example.se'] });
  mocks.unsaved.mockResolvedValue([{ kind: 'page', id: 'draft', updated_at: '2026-11-16T10:00:00Z' }]);
  mocks.activity.mockResolvedValue({ active_jobs: [{ job_id: 'other-job', site_id: 'other', kind: 'publication', status: 'running' }], awaiting_approval: [] });
  const plan = await publicationPlan('org', 'site', 'main');
  expect(plan).toMatchObject({ verdict: 'blocked', build_engine: { node_version: '22.23.1', required_node_version: '22.23.5' }, unsaved: 1, builds_ahead: [{ job_id: 'other-job' }],
    blockers: [{ code: 'build_engine_update_required', message: expect.stringContaining('22.23.1') }] });
  expect(plan.steps.map(step => step.code)).toEqual(['unsaved_content', 'build_engine_update_required', 'review_configuration', 'confirm_live_domains', 'publish']);
  expect(plan.steps[1]).toMatchObject({ tool: 'setup_organization_build_engine' });
  expect(plan.notes.map(note => note.code)).toEqual(['other_builds_running', 'site_wide_build']);
});

it('estimates from the site’s own recent publications and says what makes this one longer', async () => {
  const store = getStore();
  const job = (id: string, start: string, minutes: number, extra = {}) => store.setDoc(paths.deploy('org', 'site', id), { id, version_id: 'main', environment: 'production', status: 'succeeded', started_at: start, finished_at: new Date(Date.parse(start) + minutes * 60_000).toISOString(), ...extra });
  await job('a', '2026-11-10T10:00:00Z', 4); await job('b', '2026-11-11T10:00:00Z', 6); await job('c', '2026-11-12T10:00:00Z', 30);
  await job('dry', '2026-11-13T10:00:00Z', 1, { dry_run: true });
  await job('branch', '2026-11-13T11:00:00Z', 1, { version_id: 'redesign' });
  mocks.outlook.mockResolvedValue({ would_fail: false, blockers: [], notes: [{ code: 'build_engine_update_first', message: 'updates the engine first' }], build_engine: engine });
  expect((await publicationPlan('org', 'site', 'main')).estimate).toEqual({ typical_minutes: 6, based_on_publications: 3, longer_because: ['build_engine_update_first'] });
});

it('blocks while the site is already being published and when content cannot be compared, without leaking why', async () => {
  mocks.activity.mockResolvedValue({ active_jobs: [{ job_id: 'mine', site_id: 'site', kind: 'publication', status: 'running' }], awaiting_approval: [] });
  mocks.impact.mockRejectedValue(Error('private source payload'));
  const plan = await publicationPlan('org', 'site', 'main');
  expect(plan.blockers.map(blocker => blocker.code)).toEqual(['content_comparison_failed', 'publication_running']);
  expect(plan.builds_ahead).toEqual([]);
  expect(JSON.stringify(plan)).not.toContain('private source');
});
