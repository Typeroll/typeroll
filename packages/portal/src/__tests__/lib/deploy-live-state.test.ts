import { describe, expect, it } from 'vitest';
import { liveDeploymentUpdate } from '../../lib/deploy/live-state';

const times = { contentCutoff: '2026-09-07T11:00:00Z', completedAt: '2026-09-07T11:15:00Z' };
describe('successful live deployment state', () => {
  it('does not mark main as live after a staging deployment', () => {
    expect(liveDeploymentUpdate({ ...times, versionId: 'main', environment: 'staging', deployUrl: 'https://staging.example.com' })).toBeNull();
  });
  it('records the build cutoff separately from completion for production', () => {
    expect(liveDeploymentUpdate({ ...times, versionId: 'main', environment: 'production' })).toEqual({
      last_deployed_at: '2026-09-07T11:15:00Z', last_deployed_content_at: '2026-09-07T11:00:00Z',
    });
  });
  it('keeps branch deployment state and its URL independent of main', () => {
    expect(liveDeploymentUpdate({ ...times, versionId: 'redesign', environment: 'staging', deployUrl: 'https://redesign.example.com' })).toEqual({
      last_deployed_at: '2026-09-07T11:15:00Z', last_deployed_content_at: '2026-09-07T11:00:00Z', deploy_url: 'https://redesign.example.com',
    });
  });
});
