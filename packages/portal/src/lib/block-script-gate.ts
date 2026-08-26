// Script policy for agent surfaces.
//
// Custom-block JS runs in every visitor's browser on the published site.
// The trust boundary is the CREDENTIAL, not the code shape:
//
// - **Bearer API keys (MCP + v1 REST)** may write `script` freely. The key
//   holder performed an explicit key ceremony, holds admin/write authority,
//   and the same token already authorises `scripts_head`/`custom_css` —
//   gating one JS path while others stay open was security theater
//   (decided 2026-06-11). Mitigation is VISIBILITY, not a lock: every
//   script-bearing write is audit-logged (api-audit) and the response
//   carries SCRIPT_WRITE_NOTICE so the operator sees what was stored.
//
// - **The in-portal chat AI (cookie session)** stays gated behind
//   `Site.ai_scripts_enabled`: its operators are often non-technical
//   editors with no key ceremony and no review habit, and the chat reads
//   page content (prompt-injection surface) in the same loop.
//
// Portal-cookie surfaces (BlockTypeEditor with its consent toggle) are not
// gated here — a human in the UI is the trusted author.

import { buildCoreBlockRegistry, paths } from '@typeroll/shared';
import type { BlockType, Site } from '@typeroll/shared';
import { getStore } from './datastore';

export const SCRIPT_GATE_WARNING =
  'script was ignored: the in-portal chat assistant cannot author block JS ' +
  'for this site. An org admin can enable it in the portal under Settings ' +
  '("Allow AI to write block scripts"), add the script manually in the ' +
  'block type editor, or ship it via an API key (MCP/REST), where script ' +
  'writes are allowed and audit-logged.';

export const SCRIPT_WRITE_NOTICE =
  'This write stored visitor-executed JavaScript (script field). It was ' +
  'accepted under your API key\'s authority and audit-logged. Review it in ' +
  'the block type editor before the next deploy if you did not intend this.';

export function aiScriptsEnabled(site: Pick<Site, 'ai_scripts_enabled'> | Record<string, unknown>): boolean {
  return (site as { ai_scripts_enabled?: unknown }).ai_scripts_enabled === true;
}

/**
 * CHAT-ONLY: strips `script` from a chat-tool write payload unless the site
 * has opted in. Mutates `payload`; returns warnings to surface in the
 * response (empty when nothing was stripped). Bearer-key surfaces must NOT
 * call this — they attach SCRIPT_WRITE_NOTICE instead.
 */
export function gateBlockScript(
  payload: { script?: unknown },
  site: Pick<Site, 'ai_scripts_enabled'> | Record<string, unknown>,
): string[] {
  if (payload.script === undefined) return [];
  if (aiScriptsEnabled(site)) return [];
  delete payload.script;
  return [SCRIPT_GATE_WARNING];
}

// ─── Block INSTANCE data (block.data), via BlockType.script_fields ────────
//
// Everything above governs `BlockType.script` — per-TYPE JS, written through
// the block-type routes, which do call the gate. Block INSTANCE writes
// (add_block / update_block / set_block_responsive, on every surface
// including the chat) never passed through it. That was harmless only for as
// long as no block type carried code in `block.data`; the moment one does,
// the chat AI can ship visitor-executed JS around the very gate above.
//
// Rather than adding a call site per scriptable block and hoping nobody
// forgets, the block type DECLARES which of its schema fields are code
// (`BlockType.script_fields`) and the generic write path gates whatever it
// declares. A future `core/embed` inherits the gate by declaring `js`.
//
// Note this only matters for fields the renderer emits OUTSIDE the sanitized
// body — per-instance <script> tags, the way collectBlockAssets emits
// per-type ones. Ordinary markup fields are already covered: block output
// runs through the customer-HTML sanitizer, which strips <script>.

export const INSTANCE_SCRIPT_GATE_WARNING =
  'Executable block fields were ignored: the in-portal chat assistant cannot ' +
  'author block JavaScript for this site. An org admin can enable it under ' +
  'Settings ("Allow AI to write block scripts"), edit the block in the ' +
  'portal, or ship the change via an API key (MCP/REST), where script writes ' +
  'are allowed and audit-logged.';

let coreRegistry: Map<string, BlockType> | null = null;

/**
 * Which fields of `typeId` carry executable code. Core types resolve from the
 * in-process registry (no IO); per-site types cost one getDoc, and only for
 * block types that aren't core.
 *
 * Unknown type → no script fields. That's safe rather than lax: a type that
 * doesn't exist can't render anything, and the write will fail downstream on
 * its own terms.
 */
export async function resolveScriptFields(
  orgId: string,
  siteId: string,
  versionId: string,
  typeId: string | undefined,
): Promise<string[]> {
  if (!typeId) return [];
  coreRegistry ??= buildCoreBlockRegistry();
  const core = coreRegistry.get(typeId);
  if (core) return core.script_fields ?? [];
  const custom = await getStore().getDoc<BlockType>(
    paths.blockType(orgId, siteId, typeId, versionId),
  );
  return custom?.script_fields ?? [];
}

/** True when `data` sets any of the type's declared code fields. */
export function blockDataCarriesScript(
  data: Record<string, unknown> | undefined,
  scriptFields: string[],
): boolean {
  if (!data || scriptFields.length === 0) return false;
  return scriptFields.some((f) => data[f] !== undefined);
}

/**
 * CHAT-ONLY, mirroring gateBlockScript: strips declared code fields from a
 * block-instance write unless the site has opted in. Mutates `data`; returns
 * warnings to surface in the tool result (empty when nothing was stripped).
 *
 * Bearer-key surfaces must NOT call this — they accept the write and attach
 * SCRIPT_WRITE_NOTICE instead, per the credential-is-the-boundary rule above.
 */
export function gateBlockInstanceScript(
  data: Record<string, unknown> | undefined,
  scriptFields: string[],
  site: Pick<Site, 'ai_scripts_enabled'> | Record<string, unknown>,
): string[] {
  if (!blockDataCarriesScript(data, scriptFields)) return [];
  if (aiScriptsEnabled(site)) return [];
  for (const f of scriptFields) delete data![f];
  return [INSTANCE_SCRIPT_GATE_WARNING];
}
