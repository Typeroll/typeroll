// Sanity check for the WP-migration → blocks default. The full migration
// workflow is end-to-end heavy (REST mocks, media transfer, AI prompts),
// so this test exercises only the "given the converter and a target
// mode, what does the page doc look like" decision — same logic the
// workflow uses just before writing each page doc.

import { describe, it, expect } from 'vitest';
import { htmlToBlocks } from '../../lib/html-to-blocks';

interface MigrationContext {
  config: { target_content_mode?: string };
}

/** Mirrors the doc-shape decision in lib/workflows/migration.ts. Kept
 *  inline rather than exported so a future refactor of the workflow
 *  doesn't accidentally pull the helper in two directions. */
function buildPageDoc(html: string, ctx: MigrationContext): {
  content_mode: 'blocks' | 'html';
  html_content: string;
  blocks?: Array<{ type: string }>;
} {
  const targetMode = String(ctx.config.target_content_mode ?? 'blocks');
  const useBlocks = targetMode !== 'html';
  const blocks = useBlocks ? htmlToBlocks(html).blocks : undefined;
  return {
    content_mode: useBlocks ? 'blocks' : 'html',
    html_content: html,
    ...(blocks ? { blocks: blocks as Array<{ type: string }> } : {}),
  };
}

describe('Migration page-doc shape decision', () => {
  const html = '<h1>About us</h1><p>We are great.</p><img src="/x.jpg" alt="x"/>';

  it('defaults to blocks-mode with a populated tree', () => {
    const doc = buildPageDoc(html, { config: {} });
    expect(doc.content_mode).toBe('blocks');
    expect(doc.blocks?.length).toBeGreaterThan(0);
    expect(doc.blocks?.some((b) => b.type === 'core/heading')).toBe(true);
    expect(doc.blocks?.some((b) => b.type === 'core/image')).toBe(true);
    // html_content is retained as backup (recoverable via set_page_mode)
    expect(doc.html_content).toBe(html);
  });

  it('honors target_content_mode=html opt-out', () => {
    const doc = buildPageDoc(html, { config: { target_content_mode: 'html' } });
    expect(doc.content_mode).toBe('html');
    expect(doc.blocks).toBeUndefined();
  });

  it('falls back to blocks for unknown target_content_mode values', () => {
    const doc = buildPageDoc(html, { config: { target_content_mode: 'something' } });
    expect(doc.content_mode).toBe('blocks');
  });
});
