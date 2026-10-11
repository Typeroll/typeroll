import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlock, ensureBlockIds } from '@typeroll/shared/blocks';

describe('public blocks entry point', () => {
  it('resolves from the package and renders a native heading', () => {
    const blocks = ensureBlockIds([{ type: 'core/heading', data: { text: 'Hello', level: 'h2' } }] as never);
    expect(blocks[0].id).toBeTruthy();
    expect(renderBlock(blocks[0], { registry: buildCoreBlockRegistry() })).toContain('Hello');
  });
});
