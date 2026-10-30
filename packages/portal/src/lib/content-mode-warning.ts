/**
 * A write whose content the current mode does not render is stored, but stays
 * invisible until the mode changes: blocks on an HTML page or partial, or
 * html_content on a blocks one. Reported so callers do not mistake it for a
 * visible change.
 */
export interface ContentModeMismatch { code: 'content_mode_mismatch'; content_mode: 'html' | 'blocks'; ignored_field: 'blocks' | 'html_content'; message: string }

export function contentModeMismatch(mode: unknown, body: { blocks?: unknown; html_content?: unknown }, modePath: string): ContentModeMismatch | null {
  const current = mode === 'blocks' ? 'blocks' : 'html';
  const ignored = current === 'html' && body.blocks !== undefined ? 'blocks' : current === 'blocks' && body.html_content !== undefined ? 'html_content' : null;
  if (!ignored) return null;
  const other = current === 'html' ? 'blocks' : 'html';
  return { code: 'content_mode_mismatch', content_mode: current, ignored_field: ignored,
    message: `This is in ${current} mode, so the ${ignored} you sent was stored but is not rendered. Switch with POST ${modePath} {"to":"${other}"} to render it; the switch keeps both versions.` };
}
