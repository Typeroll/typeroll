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
//   list/read/restore_page_revision        →  saved-state history (undo)
//
// The portal editor shows any agent-written draft as "Unsaved changes", so
// the human can also Save or Discard it from the UI.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, writeAuthority, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

const wcTargetSchema = z.object({
  kind: z.enum(['page', 'partial']),
  id: z.string(),
}).describe('Which doc\'s draft: page {id} or partial {id}. Templates have no drafts (their writes apply directly).');

type WcTargetArg = { kind: 'page' | 'partial'; id: string };

function wcPath(t: WcTargetArg): string {
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
      ...writeAuthority,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, wcPath(args.target), { ...(args.authority ? { authority: args.authority } : {}), ...(args.override_reason ? { override_reason: args.override_reason } : {}) }, v(args.version));
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
  {
    name: 'list_page_revisions',
    description:
      "Saved-state history of a page on this version, newest first. Every save snapshots the page as it was BEFORE the save, so each entry is a state you can go back to. Returns { revisions: [{ id, created_at, created_by, note, title, content_mode, date_updated }], total }. Use read_page_revision for the full document and restore_page_revision to undo.",
    inputSchema: {
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).optional().describe('Newest N entries (default 50).'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = { ...(v(args.version) ?? {}) };
      if (args.limit) query.limit = String(args.limit);
      const res = await client.get(siteId, `pages/${encodeURIComponent(args.page_id)}/revisions`, query);
      return ok(res);
    }),
  },
  {
    name: 'read_page_revision',
    description:
      'Read one page revision with the full saved document (title, blocks or html_content, SEO fields, fields, …) — compare it with read_page before restoring.',
    inputSchema: {
      page_id: z.string(),
      revision_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/revisions/${encodeURIComponent(args.revision_id)}`,
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'restore_page_revision',
    description:
      "Restore a page revision's content into the page's DRAFT (replacing the current draft, like replace_page). Pass save:true to save it at once; the save snapshots the current page first, so the restore is itself undoable. Publication status and schedule are kept. A revision from the other content mode is refused (409) — switch mode first. Returns { restored_revision, saved, has_unsaved_changes, staged_fields, … }.",
    inputSchema: {
      page_id: z.string(),
      revision_id: z.string(),
      save: z.boolean().optional().describe('Save immediately (default false: leave it as an unsaved draft to preview).'),
      ...writeAuthority,
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/revisions/${encodeURIComponent(args.revision_id)}/restore`,
        { save: args.save === true, ...(args.authority ? { authority: args.authority } : {}), ...(args.override_reason ? { override_reason: args.override_reason } : {}) },
        v(args.version),
      );
      return ok(res);
    }),
  },
];
