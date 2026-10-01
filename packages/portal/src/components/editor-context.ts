import { createContext } from 'react';
import type { FieldDefinition, SiteStyle } from '@typeroll/shared';

/** The site's style library, for `type: 'style'` fields. Null when no editor provides it. */
export const SiteStylesContext = createContext<SiteStyle[] | null>(null);

/** The site's render version. Null when no editor provides it; every field is then shown. */
export const RenderVersionContext = createContext<number | null>(null);

/** Converts the selected text block into separate blocks; provided by the block editor. */
export const ProseConvertContext = createContext<(() => void) | null>(null);

/** Whether a field renders on a site at this render version. */
export function fieldAvailable(field: FieldDefinition, renderVersion: number | null): boolean {
  return renderVersion === null || (field.min_render_version ?? 1) <= renderVersion;
}

export interface GlobalBlockSummary { id: string; name: string; status: 'draft' | 'published'; content_mode: 'blocks' | 'html' }

/** The site's global blocks (free partials), for `type: 'global_block'` fields and the block library. */
export const GlobalBlocksContext = createContext<{ siteId: string; blocks: GlobalBlockSummary[] } | null>(null);
