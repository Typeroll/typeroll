// Page fields an API key may write, shared by the v1 page routes (PATCH/PUT)
// and revision restore so both go through the same draft write path.

import { ensureBlockIds } from '@typeroll/shared';
import type { Page } from '@typeroll/shared';

export const WRITABLE: Array<keyof Page> = [
  'title', 'slug', 'path', 'html_content', 'blocks', 'status', 'content_mode', 'kind', 'author',
  'breadcrumb_label', 'seo_title', 'append_seo_suffix', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'noindex', 'nofollow',
  'alternates', 'lastmod_override', 'json_ld', 'schema_type', 'service',
  'template', 'date_published', 'language', 'image_sizes_default', 'custom_css',
  'publish_at', 'unpublish_at', 'fields',
];

/** Content fields PUT clears when absent from the body ("PUT replaces"). */
export const REPLACEABLE: Array<keyof Page> = WRITABLE.filter(
  (k) => k !== 'status' && k !== 'content_mode' && k !== 'date_published' && k !== 'slug'
    && k !== 'publish_at' && k !== 'unpublish_at',
);

export function pickWritable(body: Partial<Page>): Partial<Page> {
  const out: Partial<Page> = {};
  for (const k of WRITABLE) {
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k];
  }
  // Whole-tree block writes must carry ids on every block — agents
  // hand-author trees without them, and an id-less block used to 500 the
  // renderer.
  if (Array.isArray(out.blocks)) {
    out.blocks = ensureBlockIds(out.blocks);
  }
  return out;
}
