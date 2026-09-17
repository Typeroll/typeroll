import { describe, expect, it } from 'vitest';
import { countBlockH1s, normalizePageH1s, pageHeadingError } from '../page-heading-policy.js';
import { composePageWithTemplate, renderBlocks } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block } from '../types.js';

const title: Block = { id: 'title', type: 'template/page_title', data: {} };
const heading: Block = { id: 'body-title', type: 'core/heading', data: { level: 'h1', text: 'Body title' } };

describe('one Page H1', () => {
  it('rejects body H1 with a template title, including nested slots', () => {
    const body = [{ id: 'columns', type: 'core/columns', data: {}, slots: [[heading]] }];
    expect(pageHeadingError({ blocks: body }, [title])).toContain('Change body H1 headings to H2');
    expect(pageHeadingError({ blocks: [heading] })).toBeNull();
    expect(pageHeadingError({ blocks: [heading, { ...heading, id: 'second' }] })).toContain('one H1');
  });
  it('preserves the template H1 even when the body slot appears first, without mutating data', () => {
    const before = JSON.stringify(heading);
    const blocks = composePageWithTemplate([{ id: 'slot', type: 'template_content_slot', data: {} }, title], [heading]);
    const html = renderBlocks(blocks, { registry: buildCoreBlockRegistry(), context: { page: { title: 'Template title' } } });
    expect(html).toMatch(/<h2\b[^>]*>Body title<\/h2>/);
    expect(html).toMatch(/<h1\b[^>]*>Template title<\/h1>/);
    expect(JSON.stringify(heading)).toBe(before);
  });
  it('ignores comments and raw text while preserving attributes and anchors on legacy HTML', () => {
    const html = '<!-- <h1>comment</h1> --><script>const sample="<h1>x</h1>"</script><h1 id="title">Title</h1><h1 id="details">Details</h1>';
    expect(normalizePageH1s(html)).toBe(html.replace('<h1 id="details">Details</h1>', '<h2 id="details">Details</h2>'));
    expect(countBlockH1s([{ id: 'html', type: 'core/html', data: { html } }])).toBe(2);
    expect(pageHeadingError({ content_mode: 'html', html_content: '<h1>Only title</h1>' }, [title])).toBeNull();
  });
});
