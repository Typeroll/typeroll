import { describe, expect, it } from 'vitest';
import { LATEST_RENDER_VERSION, buildCoreBlockRegistry, renderBlocks } from '@typeroll/shared';
import { sanitizeBody as portal } from '../../lib/sanitize';
import { sanitizeBody as renderer } from '../../../../site-template/src/lib/sanitize';

describe.each([['preview', portal], ['published', renderer]] as const)('%s HTML keeps a container language', (_name, sanitize) => {
  it('keeps lang and dir on the container element', () => {
    const html = renderBlocks([
      { id: 'fr', type: 'core/container', data: { lang: 'fr-BE' }, children: [{ id: 'h', type: 'core/heading', data: { text: 'Je déménage', level: 'h2' } }] },
      { id: 'ar', type: 'core/container', data: { lang: 'ar', layout: 'flow' }, children: [] },
    ], { registry: buildCoreBlockRegistry(), renderVersion: LATEST_RENDER_VERSION, context: { page: { language: 'nl-BE' } } as never });
    const out = sanitize(html);
    expect(out).toMatch(/<div[^>]*lang="fr-BE"[^>]*data-block="container"/);
    expect(out).toMatch(/<div[^>]*lang="ar" dir="rtl"[^>]*data-block="semantic-container"/);
  });
});
