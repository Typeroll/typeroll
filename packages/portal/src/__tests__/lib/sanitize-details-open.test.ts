import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks } from '@typeroll/shared';
import { sanitizeBody as portal } from '../../lib/sanitize';
import { sanitizeBody as renderer } from '../../../../site-template/src/lib/sanitize';

describe.each([['portal', portal], ['renderer', renderer]] as const)('%s keeps an open accordion item open', (_name, sanitize) => {
  it('keeps the open attribute on <details>', () => {
    expect(sanitize('<details open><summary>Q</summary><p>A</p></details>')).toContain('<details open');
  });

  it('keeps the first item of a "Default open: first" accordion open (render version 4)', () => {
    const html = renderBlocks([{ id: 'faq', type: 'core/accordion', data: {
      default_open: 'first',
      items: [{ title: 'One', content: '<p>1</p>' }, { title: 'Two', content: '<p>2</p>' }],
    } }], { registry: buildCoreBlockRegistry(), renderVersion: 4 });
    const details = sanitize(html).match(/<details[^>]*>/g) ?? [];
    expect(details).toHaveLength(2);
    expect(details[0]).toMatch(/\sopen/);
    expect(details[1]).not.toMatch(/\sopen/);
  });
});
