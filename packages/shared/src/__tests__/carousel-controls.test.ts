import { describe, expect, it } from 'vitest';
import { CAROUSEL_RUNTIME, CAROUSEL_RUNTIME_V14, blockOutputForVersion, buildCoreBlockRegistry } from '../index.js';

describe('carousel controls', () => {
  it('show only while the track scrolls from version 14', () => {
    expect(CAROUSEL_RUNTIME_V14).toContain('controls.hidden = maxScroll() <= 1;');
    expect(CAROUSEL_RUNTIME_V14).not.toContain('controls.hidden = false;');
    const repeater = buildCoreBlockRegistry().get('core/repeater')!;
    expect(blockOutputForVersion(repeater, 14).script).toBe(CAROUSEL_RUNTIME_V14);
    expect(blockOutputForVersion(repeater, 13).script).toBe(CAROUSEL_RUNTIME);
  });
});
