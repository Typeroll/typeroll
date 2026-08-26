// Draft-layer (working copy) tools — the explicit-save half of the buffer
// model. Every content write on this platform (yours, other agents', the
// human editor's) lands in a per-doc DRAFT; deploys and default previews
// see saved content only. These tools read, save, and discard that draft:
//
//   edits (update_page / block tools / …)  →  unsaved draft
//   get_preview_link include_working_copy  →  look at the draft
//   commit_working_copy                    →  SAVE (same op as the editor's
//                                              Save button)
//   discard_working_copy                   →  throw the draft away
//
// The portal editor shows any agent-written draft as "Unsaved changes", so
// the human can also Save or Discard it from the UI.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

const wcTargetSchema = z.object({
  kind: z.enum(['page', 'partial', 'item']),
  id: z.string(),
  collection: z.string().optional().describe('Required when kind="item": the collection name.'),
}).describe('Which doc\'s draft: page {id}, partial {id}, or collection item ({collection} + {id}). Templates/item templates have no drafts (their writes apply directly).');

type WcTargetArg = { kind: 'page' | 'partial' | 'item'; id: string; collection?: string };

function wcPath(t: WcTargetArg): string {
  if (t.kind === 'item') {
    if (!t.collection) throw new Error('collection is required when kind="item"');
    return `working-copy/item/${encodeURIComponent(t.collection)}/${encodeURIComponent(t.id)}`;
  }
  return `working-copy/${t.kind}/${encodeURIComponent(t.id)}`;
}

export const workingCopyTools: ToolDef[] = [
  {
    name: 'read_working_copy',
    description:
      'Read a doc\'s unsaved draft (working copy) as a raw field diff — { working_copy: null } means everything is saved. read_page/get_page_blocks already return the draft VIEW; use this when you need to know exactly WHICH fields are unsaved, e.g. before discarding (the draft may hold the user\'s in-progress editor work, not just yours).',
    inputSchema: {
      target: wcTargetSchema,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, wcPath(args.target), v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'commit_working_copy',
    description:
      'SAVE a doc\'s unsaved draft: promote it onto the saved doc through the canonical write path (revision snapshot, SEO transform, redirect hygiene) and delete the draft. Identical to the Save button in the portal editor. Returns { committed, seo_warnings, auto_redirects, retired_redirects }. Never changes publish status. Deploys only ship saved content, so commit before trigger_deploy. Equivalent shortcut: save:true on the write tools.',
    inputSchema: {
      target: wcTargetSchema,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, wcPath(args.target), {}, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'discard_working_copy',
    description:
      'Throw away a doc\'s unsaved draft — the saved doc is untouched. Use when the user rejects the previewed change. CAUTION: the draft is shared with the human editor; read_working_copy first if you\'re not sure whose edits are in it.',
    inputSchema: {
      target: wcTargetSchema,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, wcPath(args.target), v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'get_change_summary',
    description:
      "Structured summary of a page's unsaved draft — exactly what Save (commit_working_copy) would apply: `meta_changed` (draft meta fields differing from the saved page) + `block_changes` (block-tree diff: added/removed/changed/moved, with changed field names and move paths). Use it to DESCRIBE YOUR OWN EDITS to the user before asking for approval, or to inspect what another editor/agent left in the draft. Pairs with get_preview_link include_working_copy for the visual side.",
    inputSchema: {
      page_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/changes`,
        v(args.version),
      );
      return ok(res);
    }),
  },
];
