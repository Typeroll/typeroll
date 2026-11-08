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
});
