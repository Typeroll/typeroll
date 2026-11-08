// Copy and paste of blocks between pages and sites, like Cmd/Ctrl+C and V in
// the block editor. Each tool maps onto /api/v1/sites/{siteId}/clipboard/*.
// copy_blocks returns the clipboard text; paste_blocks takes it on any site
// the connection can write, the same or another.

import { z } from 'zod';
import { ok, versionParam, withErrorBoundary, type ToolDef } from './helpers.js';

const v = (version?: string) => (version ? { version } : undefined);

const STYLES =
  'Into another site, the styles the blocks use are created there, never mapped to "nearest" styles: one the site has with another definition is created under a new id (hero-2, "Hero (imported)") and the pasted blocks are rewritten to it; an identical one is reused. Site block types and free global blocks follow the same rule, app blocks reconnect to the app when the site has it installed, and links to the source site\'s pages become plain addresses. Each media file is copied into the site\'s Media library only when this connection may read the site it came from (an organization key reads the organization\'s sites, a site key only its own); a private file it cannot read is left out with a warning. Into the same site the blocks are placed as they are.';

export const clipboardTools: ToolDef[] = [
  {
    name: 'copy_blocks',
    description:
      'Copy blocks of a page\'s draft (with everything inside them) to a clipboard, as Cmd/Ctrl+C does in the block editor. Returns { clipboard, count: { top, total }, warnings }: clipboard is a JSON text marked "typeroll_clipboard" that holds the blocks in page order with the styles, site block types and free global blocks they use; media stay at their addresses. Pass clipboard unchanged to paste_blocks on this or another site. A person can paste the same text in the block editor with Cmd/Ctrl+V. Writes nothing.',
    inputSchema: {
      page_id: z.string().min(1),
      block_ids: z.array(z.string().min(1)).min(1).max(200).describe('Ids of the blocks to copy (from read_page); a block inside another listed block comes with it.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async ({ version, ...body }, { client, siteId }) => {
      const result = await client.post(siteId, 'clipboard/copy', body, v(version)) as { clipboard_text?: string; count?: unknown; warnings?: unknown };
      return ok({ clipboard: result.clipboard_text, count: result.count, warnings: result.warnings });
    }),
  },
  {
    name: 'paste_blocks',
    description:
      'Paste blocks from copy_blocks (or text a person copied in the block editor) into a page\'s draft, with new block ids: after after_block_id (in that block\'s parent or slot when it is nested), or at position (top level, or in parent_id / slot_index); at the end by default. Returns { report, page: { id, added_ids, blocks }, mode (same_site | other_site), media: { copied, reused, left_out, kept_external }, message }; save the page to publish the change. ' + STYLES,
    inputSchema: {
      clipboard: z.string().min(1).describe('The clipboard text from copy_blocks, unchanged.'),
      page_id: z.string().min(1),
      after_block_id: z.string().optional(),
      position: z.number().int().min(0).optional(),
      parent_id: z.string().nullable().optional(),
      slot_index: z.number().int().min(0).optional(),
      version: versionParam,
    },
    handler: withErrorBoundary(async ({ version, ...body }, { client, siteId }) => ok(await client.post(siteId, 'clipboard/paste',
      Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)), v(version)))),
  },
];
