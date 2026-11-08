// Live snippets: small pieces of content a site keeps outside its
// publication. A save is written at once as a public file the live site
// reads, so it changes without publishing. They belong to the site, not to a
// version, so these tools take no `version`.

import { z } from 'zod';
import { ApiError } from '../client.js';
import { fail, ok, type ToolDef, type ToolResult } from './helpers.js';

const SNIPPET_MODEL =
  'A live snippet is content outside the build: saving it updates the live site within about a minute, without a publication or a rebuild, so use it for content that changes often (today\'s lunch, a notice, the current waiting time). ' +
  'Snippets belong to the site (not to a branch), at most 100 per site and 64 KB each. Shape: { id, name, kind, format?, content?, entries?, fallback? }. ' +
  'kind "html": content is HTML, sanitized like page content when saved. kind "text": content is plain text, escaped when shown. ' +
  'kind "dated": entries keyed by date or weekday, and the page shows today\'s entry in the site\'s time zone (read_site_settings → time_zone), chosen in the visitor\'s browser: ' +
  '{ kind: "dated", format: "html" | "text", entries: [{ weekday: "monday", content: "…" }, …, { date: "2026-12-24", content: "Closed" }], fallback: "No lunch today" }. ' +
  'A date entry wins over a weekday entry; fallback shows on a day without one. For "today\'s lunch", write the whole week once (one entry per weekday, plus dated exceptions) instead of saving every day; the file stays unchanged between writes. ' +
  'To show a snippet on a page, place a `core/snippet` block with data { snippet: "<snippet id>" } where it should appear: the page carries the value of the latest publication (for search engines and without script) and the browser then shows the newest. Previews (get_preview_link, get_page_preview, the editor) render the snippet as saved when they are opened and fetch no live file; reload a preview to see a later save. ' +
  'Placing or moving the block is a page edit that needs a publication; changing the snippet afterwards does not. ' +
  'A site field defined with `live: true` (define_site_fields) works the same way for a single value: the `core/site_field` block shows its newest value without publishing. ' +
  'Every save answers `live`: { published: true, url } when the public file was written, or { published: false, reason } when the site has no media host that can serve it (the snippet is still saved and shows at the next publication).';

/** A refused save carries every problem with its path; show them plainly. */
function snippetFailure(error: unknown): ToolResult {
  if (error instanceof ApiError && error.status === 400) {
    const errors = (error.body as { details?: { errors?: Array<{ path: string; message: string }> } } | null)?.details?.errors;
    if (Array.isArray(errors) && errors.length) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'The snippet was not saved: it is not valid.', status: 400, errors,
          hint: 'Fix each path (for example entries[2].weekday) and send the whole snippet again.',
        }, null, 2) }],
        isError: true,
      };
    }
  }
  if (error instanceof ApiError && error.status === 409) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: error.message, status: 409,
        hint: 'Someone saved the snippet after you read it (or the id is taken, or the site has 100 snippets). read_snippet again and reapply your change with the new updated_at.',
      }, null, 2) }],
      isError: true,
    };
  }
  return fail(error);
}

const idParam = z.string().describe('The snippet id: lowercase letters, digits, - and _ (for example "lunch").');
const entryShape = z.object({
  date: z.string().optional().describe('A calendar date, 2026-11-09. Wins over a weekday entry.'),
  weekday: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
  content: z.string().describe('HTML or plain text, as the snippet\'s format.'),
});

export const snippetTools: ToolDef[] = [
  {
    name: 'list_snippets',
    description:
      'List the site\'s live snippets with their content and updated_at, and `live.base_url`: where their public files are served (null with a reason when the site has no media host, so snippets only change at publication). ' + SNIPPET_MODEL,
    inputSchema: {},
    handler: async (_args, { client, siteId }) => {
      try { return ok(await client.get(siteId, 'snippets')); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'read_snippet',
    description: 'Read one live snippet, its updated_at (pass it to update_snippet as expected_updated_at) and live_url, the public file the live site reads. For the model, see list_snippets.',
    inputSchema: { snippet_id: idParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.get(siteId, `snippets/${encodeURIComponent(args.snippet_id)}`)); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'update_snippet',
    description:
      'Create or replace a whole live snippet; it is live within about a minute, without publishing. Send every field you keep: what is left out is removed. ' +
      'Pass the updated_at from read_snippet as expected_updated_at (or "" to create one that must not exist yet); a save made in between is refused with 409. ' +
      'Example (the week\'s lunch): { snippet_id: "lunch", name: "Lunch", kind: "dated", format: "html", entries: [{ weekday: "monday", content: "<p>Pea soup and pancakes</p>" }, …], fallback: "<p>No lunch served today</p>" }. ' +
      'Then show it with a `core/snippet` block { snippet: "lunch" } if no page shows it yet. ' + SNIPPET_MODEL,
    inputSchema: {
      snippet_id: idParam,
      name: z.string().describe('The name editors see, for example "Today\'s lunch".'),
      kind: z.enum(['html', 'text', 'dated']),
      format: z.enum(['html', 'text']).optional().describe('dated snippets: whether entries are HTML (default) or plain text.'),
      content: z.string().optional().describe('html and text snippets: the content.'),
      entries: z.array(entryShape).optional().describe('dated snippets: entries by weekday or date, at most 400.'),
      fallback: z.string().optional().describe('dated snippets: shown on a day without an entry.'),
      expected_updated_at: z.string().nullable().optional().describe('The updated_at you read; "" or null for a new snippet.'),
    },
    handler: async (args, { client, siteId }) => {
      const { snippet_id: id, expected_updated_at: expected, ...snippet } = args as Record<string, unknown> & { snippet_id: string };
      try {
        return ok(await client.put(siteId, `snippets/${encodeURIComponent(id)}`, { ...snippet, ...(expected !== undefined ? { expected_updated_at: expected } : {}) }));
      } catch (error) { return snippetFailure(error); }
    },
  },
  {
    name: 'delete_snippet',
    description: 'Delete a live snippet and its public file. A `core/snippet` block that still shows it keeps the value of the latest publication until the page is published again; remove the block too. Pass expected_updated_at to refuse deleting a snippet changed since you read it.',
    inputSchema: {
      snippet_id: idParam,
      expected_updated_at: z.string().optional().describe('The updated_at you read.'),
    },
    handler: async (args, { client, siteId }) => {
      try {
        return ok(await client.del(siteId, `snippets/${encodeURIComponent(args.snippet_id)}`,
          args.expected_updated_at !== undefined ? { expected_updated_at: args.expected_updated_at } : undefined));
      } catch (error) { return snippetFailure(error); }
    },
  },
];
