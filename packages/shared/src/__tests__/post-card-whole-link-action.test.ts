import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, WHOLE_CARD_ACTION_RENDER_VERSION } from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (data: Record<string, unknown>, renderVersion: number, item?: Record<string, unknown>) =>
  renderBlocks([{ id: 'card', type: 'core/post_card', data }], { registry, renderVersion, ...(item ? { context: { item } } : {}) } as never);
// moveria-fi (2026-11-16): checklist cards with "NÄYTÄ →" could only be opened from the title or label.
const card = { title: 'Tarkistuslista: muuttopäivän ostoslista', href: '/tarkistuslista/', image: 'https://media.example.com/a.jpg', image_alt: '', whole_card_link: true, action_label: 'Näytä →' };

describe('a whole-card link on a Post card with an action label', () => {
  it('links the whole card from render version 22, keeping the title and the label as links to the same page', () => {
    const html = render(card, WHOLE_CARD_ACTION_RENDER_VERSION);
    expect(html).toContain('data-whole="true"');
    expect(html).toContain('<a class="block-postcard-action" href="/tarkistuslista/">Näytä →</a>');
    expect(html).toMatch(/class="block-postcard-title"[^>]*>\s*<a href="\/tarkistuslista\/" class="block-postcard-link">/);
    // The image is covered by the card link instead of being a third link.
    expect([...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1])).toEqual(['/tarkistuslista/', '/tarkistuslista/']);
  });

  it('keeps separate links up to render version 21', () => {
    const html = render(card, WHOLE_CARD_ACTION_RENDER_VERSION - 1);
    expect(html).toContain('data-whole="false"');
  });

  it('still keeps separate links when a download goes somewhere else', () => {
    const html = render({ ...card, download_url_field: 'pdf' }, WHOLE_CARD_ACTION_RENDER_VERSION, { pdf: 'https://media.example.com/list.pdf' });
    expect(html).toContain('list.pdf');
    expect(html).not.toContain('data-whole="true"');
  });
});
