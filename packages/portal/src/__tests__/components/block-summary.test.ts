import { describe, expect, it } from 'vitest';
import type { Block } from '@typeroll/shared';
import { blockSummary } from '../../components/BlockPageEditor';

const prose = (html: string): Block => ({ id: 'text', type: 'core/prose', data: { html } });
describe('editor block summaries', () => {
  it('decodes Swedish numeric and named entities without changing stored content', () => {
    const block = prose('<p>V&#xe4;lkommen till &Aring;ngermanland, &#246;ar &amp; sj&ouml;ar.</p>');
    expect(blockSummary(block)).toBe('Välkommen till Ångermanland, öar & sjöar.');
    expect(block.data.html).toContain('&#xe4;');
  });
  it('decodes entities even without markup and normalizes nonbreaking spaces', () => {
    expect(blockSummary(prose('V&auml;lkommen&nbsp;till &#x1F3D6;'))).toBe('Välkommen till 🏖');
  });
  it('decodes exactly once and keeps escaped markup as inert text', () => {
    expect(blockSummary(prose('<p>&lt;img src=x onerror=alert(1)&gt; &amp;aring;</p>'))).toBe('<img src=x onerror=alert(1)> &aring;');
  });
  it('preserves comparison operators in ordinary text', () => {
    expect(blockSummary(prose('1 < 2 &amp; 3 > 0'))).toBe('1 < 2 & 3 > 0');
  });
  it('shortens human-readable text after decoding', () => {
    expect(blockSummary(prose('&aring;'.repeat(81)))).toBe('å'.repeat(80) + '…');
  });
});
