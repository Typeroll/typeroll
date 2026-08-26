// Invariant: a `var(--x)` WITHOUT a fallback inside a block's styles must
// resolve somewhere — otherwise any shorthand using it is invalid at
// computed-value time and the WHOLE declaration silently becomes initial.
// That's how `padding: var(--block-pad-md) 1rem` on core/section shipped
// with zero side padding on every site: the var was never defined, so the
// padding collapsed to 0 and the data-pad rules only restored top/bottom.
//
// Accepted definition sites for a no-fallback var:
//   1. the block's own template (instance vars: style="--x:{{field}}")
//   2. the block's own styles (--x: … declaration)
//   3. BLOCKS_RUNTIME_CSS
//   4. site-shell theme tokens (--color-*, --font-*, --container-*,
//      --spacing-*, --radius-* — defined by BaseLayout/render-preview)
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { BLOCKS_RUNTIME_CSS } from '../render-blocks.js';

const SHELL_TOKEN = /^--(color|font|container|spacing|radius)-/;

describe('block styles never reference undefined CSS variables without fallback', () => {
  const registry = buildCoreBlockRegistry();

  it('every no-fallback var() resolves to a definition', () => {
    const failures: string[] = [];
    expect(registry.size).toBeGreaterThan(20); // guard against vacuous pass
    for (const [id, type] of registry.entries()) {
      const styles = type.styles ?? '';
      const template = type.template ?? '';
      // var(--x) with no comma before the closing paren = no fallback
      for (const m of styles.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const name = m[1];
        if (SHELL_TOKEN.test(name)) continue;
        const definedInTemplate = template.includes(`${name}:`);
        const definedInStyles = new RegExp(`${name}\\s*:`).test(styles.replace(m[0], ''));
        const definedInRuntime = BLOCKS_RUNTIME_CSS.includes(`${name}:`);
        if (!definedInTemplate && !definedInStyles && !definedInRuntime) {
          failures.push(`${id}: var(${name}) has no fallback and no definition`);
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('core/section keeps the padding fallback (regression)', () => {
    const section = registry.get('core/section');
    expect(section?.styles).toContain('var(--block-pad-md, 4rem) 1rem');
  });
});
