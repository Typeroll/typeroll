/**
 * Reference docs for the starter design system that ships with new sites.
 *
 * Exposed to the AI chat via the `read_design_notes` tool. The prompt does
 * NOT assume this design is in use — the customer may have replaced the
 * header/footer with a totally different style, hardcoded their own CSS,
 * or migrated from a WordPress theme that doesn't follow any of these
 * conventions. The AI's instruction is to inspect existing partials/pages
 * first; this doc is only the fallback when the site looks blank or when
 * the existing content clearly follows the starter conventions.
 *
 * Single source of truth: the MCP skill `tr-starter-design`
 * (packages/mcp-server/skills/tr-starter-design.md), so the chat and external
 * agents read the same text. Edit the skill and run `npm run gen` in
 * packages/mcp-server.
 */

import { BUNDLED_SKILLS } from '@typeroll/mcp-server/bundled-content';

function withoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

export const DESIGN_NOTES_STARTER = withoutFrontmatter(BUNDLED_SKILLS['tr-starter-design'] ?? '');
