import { describe, expect, it } from 'vitest';
import { blockOutputForVersion } from '../render-version.js';

describe('render version 16', () => {
  it('lines an audio cover up with the top of its text, and leaves older sites as they were', async () => {
    const { buildCoreBlockRegistry } = await import('../core-blocks.js');
    const audio = buildCoreBlockRegistry().get('core/audio')!;
    expect(blockOutputForVersion(audio, 15).styles).toContain('align-items:center;');
    expect(blockOutputForVersion(audio, 16).styles).toContain('align-items:start;');
    expect(blockOutputForVersion(audio, 16).styles).not.toContain('align-items:center;');
  });

  it('puts a lone form field beside its button only while the form keeps its default layout', async () => {
    const { buildCoreBlockRegistry } = await import('../core-blocks.js');
    const { renderBlocks } = await import('../render-blocks.js');
    const registry = buildCoreBlockRegistry();
    const form = (data: Record<string, unknown>) => ({ id: 'f1', type: 'core/navigation_form', data: { destination: '/find', fields: [{ name: 'zip', label: 'Postcode' }], ...data } });
    const html = (data: Record<string, unknown>, renderVersion: number) => renderBlocks([form(data)], { registry, renderVersion });
    expect(html({}, 16)).toContain('data-compact="true"');
    expect(html({ columns: '2' }, 16)).toContain('data-compact="false"');
    expect(html({ columns: { mobile: '1', desktop: '3' } }, 16)).toContain('data-compact="false"');
    expect(html({ column_widths: '1fr 180px' }, 16)).toContain('data-compact="false"');
    expect(html({ fields: [{ name: 'zip', label: 'Postcode' }, { name: 'city', label: 'City' }] }, 16)).toContain('data-compact="false"');
    expect(html({}, 15)).not.toContain('data-compact');
  });

  it('names the parts of the menu button and drops the search note that no longer renders', async () => {
    const { buildCoreBlockRegistry } = await import('../core-blocks.js');
    const { blockPartsAt } = await import('../block-parts.js');
    const registry = buildCoreBlockRegistry();
    const navigation = registry.get('core/navigation')!;
    expect(blockOutputForVersion(navigation, 16).template).toContain('class="block-navigation-toggle-icon"');
    expect(blockOutputForVersion(navigation, 15).template).not.toContain('block-navigation-toggle-icon');
    expect(blockPartsAt(navigation, 16).map(part => part.name)).toContain('toggle_icon');
    expect(blockPartsAt(navigation, 15).map(part => part.name)).not.toContain('toggle_icon');
    const search = registry.get('core/search')!;
    expect(blockPartsAt(search, 15).map(part => part.name)).toContain('note');
    expect(blockPartsAt(search, 16).map(part => part.name)).not.toContain('note');
  });
});
