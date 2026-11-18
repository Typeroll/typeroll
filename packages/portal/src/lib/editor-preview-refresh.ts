/** The canvas is visual. Metadata is reflected by the next explicit Save or
 * standalone preview; editing it must not continually reload the iframe. */
const HEAD_ONLY = new Set(['seo_title', 'seo_description', 'og_title', 'og_description', 'og_image', 'seo_image_alt', 'canonical_url', 'noindex', 'nofollow', 'append_seo_suffix', 'lastmod_override', 'json_ld']);
export function changesVisualPreview(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some(key => !HEAD_ONLY.has(key));
}
export function changedEditorFields(next: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key])));
}
/** Coalesce quick edits and hold refreshes across draft flush + commit. */
export function createPreviewRefreshQueue(refresh: () => void, delay = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined, held = false, pending = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const request = () => {
    pending = true; cancel();
    if (!held) timer = setTimeout(() => { timer = undefined; pending = false; refresh(); }, delay);
  };
  return {
    request,
    hold() { held = true; cancel(); },
    release() { held = false; if (pending) request(); },
    dispose() { cancel(); pending = false; },
  };
}
