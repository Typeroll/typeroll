// Structured-data tools: FAQPage, Recipe and Event JSON-LD on a page.
//
// The same inputs, validation and builders as the portal AI chat's tools of
// the same names (../structured-data.ts). Each tool reads the page's draft
// view, merges the new node into its json_ld (same @type replaced, others
// kept) and writes json_ld back through update_page's route, so the change
// follows the buffer model like any other content write.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef, type ToolResult } from './helpers.js';
import { mergeJsonLd, STRUCTURED_DATA, StructuredDataError, type StructuredDataKind } from '../structured-data.js';

const DESCRIPTIONS: Record<StructuredDataKind, string> = {
  faq: 'Add FAQPage JSON-LD to a page that visibly presents these questions and answers (Google penalizes FAQ markup for content the page does not show). Copy the questions and answers from the page.',
  recipe: 'Add Recipe JSON-LD to a recipe page: name, ingredients and steps (required), plus description, image, author, ISO 8601 durations (PT30M) and yield.',
  event: 'Add Event JSON-LD to a page about one upcoming event: name and ISO 8601 start_date with UTC offset (required), end, place, image and ticket offer. A price needs offers_currency.',
};

const COMMON = ' Validates the input and builds the schema.org JSON-LD for you; prefer this to hand-writing json_ld. It is merged into the page\'s json_ld: an existing node of the same @type is replaced, other nodes (e.g. LocalBusiness) are kept in an @graph. Returns the stored JSON-LD and warnings about rich-result eligibility. BUFFER MODEL: lands in the page\'s unsaved draft; pass save:true or commit_working_copy after the user approves. Needs write permission.';

function v(version?: string): Record<string, string> | undefined {
  return version ? { version } : undefined;
}

function invalid(error: StructuredDataError): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: error.message, issues: error.issues }, null, 2) }], isError: true };
}

export const structuredDataTools: ToolDef[] = (Object.keys(STRUCTURED_DATA) as StructuredDataKind[]).map((kind) => {
  const spec = STRUCTURED_DATA[kind];
  return {
    name: spec.tool,
    description: DESCRIPTIONS[kind] + COMMON,
    inputSchema: {
      page_id: z.string().min(1),
      ...spec.shape,
      save: z.boolean().optional().describe('Also save (commit) the draft in the same call, for a change the user already approved.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { page_id, save, version, ...input } = args as Record<string, unknown> & { page_id: string; save?: boolean; version?: string };
      let built: ReturnType<typeof spec.build>;
      let merged: ReturnType<typeof mergeJsonLd>;
      const path = `pages/${encodeURIComponent(page_id)}`;
      try {
        built = spec.build(input);
        // The draft view, so an unsaved json_ld edit is merged, not lost.
        const current = await client.get<{ page?: { json_ld?: string | null } }>(siteId, path, v(version));
        merged = mergeJsonLd(current.page?.json_ld, built.node);
      } catch (error) {
        if (error instanceof StructuredDataError) return invalid(error);
        throw error;
      }
      await client.patch(siteId, path, { json_ld: merged.json_ld, ...(save ? { save: true } : {}) }, v(version));
      return ok({
        ok: true,
        page_id,
        schema_type: spec.type,
        replaced_same_type: merged.replaced,
        kept_other_nodes: merged.kept,
        saved: !!save,
        warnings: built.warnings,
        json_ld: JSON.parse(merged.json_ld),
        next: save ? 'Saved. Deploy when the user wants it live.' : 'Unsaved draft: preview with get_preview_link include_working_copy:true, then save with commit_working_copy when approved.',
      });
    }),
  };
});
