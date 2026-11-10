import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.fn();
vi.mock('../../lib/version-store', () => ({ vstore: { settings: (...args: unknown[]) => settings(...args), blockTypes: async () => [] } }));

import { buildCoreBlockRegistry } from '@typeroll/shared';
import { singleBlockWriteWarnings, treeWriteWarnings } from '../../lib/block-write-warnings';

const ctx = { orgId: 'org', siteId: 'site', versionId: 'main' };
const registry = buildCoreBlockRegistry();
const gatedTree = [{ id: 'sec', type: 'core/section', data: {}, children: [{ id: 'cmp', type: 'core/embed', data: { html: '<p>x</p>', consent: 'optional' } }] }];

beforeEach(() => settings.mockReset());

describe('consent-gated embed write warnings', () => {
  it('warns on a tree write when the cookie banner is off', async () => {
    settings.mockResolvedValue({ cookie_consent: { enabled: false } });
    const warnings = await treeWriteWarnings(ctx, gatedTree, registry);
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'consent_embed_without_banner', block_id: 'cmp', path: 'blocks[0].children[0].data.consent',
    })]));
  });

  it('stays quiet when the banner is on', async () => {
    settings.mockResolvedValue({ cookie_consent: { enabled: true } });
    const warnings = await treeWriteWarnings(ctx, gatedTree, registry);
    expect(warnings.some(w => w.code === 'consent_embed_without_banner')).toBe(false);
  });

  it('does not warn about an embed without the gate', async () => {
    settings.mockResolvedValue({});
    const warnings = await treeWriteWarnings(ctx, [{ id: 'e', type: 'core/embed', data: { html: '<p>x</p>' } }], registry);
    expect(warnings.some(w => w.code === 'consent_embed_without_banner')).toBe(false);
  });

  it('warns when a single-block write turns the gate on without a banner', async () => {
    settings.mockResolvedValue({});
    const blocks = [{ id: 'cmp', type: 'core/embed', data: { html: '<p>x</p>' } }];
    const warnings = await singleBlockWriteWarnings(ctx, blocks, 'cmp', { data: { consent: 'optional' } }, registry);
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'consent_embed_without_banner', path: 'cmp.data.consent' })]));
    // An unrelated later edit does not repeat it.
    settings.mockClear();
    const later = await singleBlockWriteWarnings(ctx, [{ id: 'cmp', type: 'core/embed', data: { html: '<p>x</p>', consent: 'optional' } }], 'cmp', { data: { html: '<p>y</p>' } }, registry);
    expect(later.some(w => w.code === 'consent_embed_without_banner')).toBe(false);
  });
});
