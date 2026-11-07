// Site fields: settings pages a builder defines and the client fills in, like
// WordPress options pages. One document per version with the definitions
// (`groups`) and the values; saved directly (revision checked, no working
// copy) and live with the next publication.

import { z } from 'zod';
import { ApiError } from '../client.js';
import { fail, ok, versionParam, type ToolDef, type ToolResult } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

const OPENING_HOURS_SHAPE = JSON.stringify({
  name: 'opening_hours', label: 'Opening hours', type: 'object', presentation: 'opening_hours',
  fields: [
    { name: 'days', label: 'Week', type: 'array', min_items: 7, max_items: 7, item_label: 'day', fields: [
      { name: 'day', label: 'Day', type: 'select', options: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
      { name: 'closed', label: 'Closed', type: 'boolean' },
      { name: 'opens', label: 'Opens', type: 'text', placeholder: '09:00' },
      { name: 'closes', label: 'Closes', type: 'text', placeholder: '09:00' },
    ] },
    { name: 'exceptions', label: 'Exceptions', type: 'array', max_items: 60, item_label: 'date', fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'closed', label: 'Closed', type: 'boolean' },
      { name: 'opens', label: 'Opens', type: 'text' },
      { name: 'closes', label: 'Closes', type: 'text' },
      { name: 'note', label: 'Note', type: 'text' },
    ] },
  ],
});

const SITE_FIELDS_MODEL =
  'Site fields are settings pages for the client: a builder defines groups of typed fields once, and the client (an editor) fills in the values without touching pages or design. ' +
  'A group is { id, label, description?, access: "editor" | "admin", fields }. access "editor" (the default) lets anyone who edits content change the values; "admin" only site administrators. Definitions are always site admin. ' +
  'Fields use the content type field model: { name, type, label, required?, help?, placeholder?, default? } with type text, textarea, richtext, boolean (a checkbox, e.g. show_booking), number (min, max), select or multiselect (options), date (2026-11-07), datetime, image, url, email, page_ref, ' +
  'array (a list: fields, item_label, min_items, max_items) or object (a group of fields). Lists and groups nest at most 3 levels. Field names are lowercase_with_underscores and unique across the whole site. ' +
  'Opening hours: an object field with presentation "opening_hours" and exactly this shape (a 7-day week plus dated exceptions such as holidays): ' + OPENING_HOURS_SHAPE + ' ' +
  'Its value: { days: [{ day: "monday", opens: "09:00", closes: "17:00" }, …, { day: "sunday", closed: true }], exceptions: [{ date: "2026-12-24", closed: true, note: "Christmas Eve" }] }. ' +
  'Using values on the site: `{{site.fields.name}}` (and `{{#each site.fields.list}}…{{/each}}`) in page templates and block text; the `core/site_field` block shows one value with data { field: "name", format } where format is text, date, number, list, opening_hours_today, opening_hours_week, next_opening or open_now; ' +
  'and the `core/show_if` block shows its children only when its condition holds, e.g. { condition: "site.fields.show_booking" } around a booking calendar. Values reach the live site with the next publication, ' +
  'except for a top-level field defined with `live: true` (any type, but no list inside a list; opening hours qualify): its value is also published as a live file when saved, and the `core/site_field` block then shows the newest value without a publication (see list_snippets).';

/** A refused save carries every problem with its path; show them plainly. */
function siteFieldsFailure(error: unknown, what: 'definitions' | 'values'): ToolResult {
  if (error instanceof ApiError && error.status === 400) {
    const errors = (error.body as { errors?: Array<{ path: string; message: string }> } | null)?.errors;
    if (Array.isArray(errors) && errors.length) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `The site field ${what} were not saved: they are not valid.`,
            status: 400,
            errors,
            hint: what === 'definitions'
              ? 'Fix each path (for example groups[0].fields[2].options) and send all groups again.'
              : 'Fix each path (for example opening_hours.days[0].opens) and send those values again. read_site_fields shows the field definitions.',
          }, null, 2),
        }],
        isError: true,
      };
    }
  }
  if (error instanceof ApiError && error.status === 409) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          status: 409,
          hint: 'Someone saved the site fields after you read them. read_site_fields again and reapply your change with the new updated_at.',
        }, null, 2),
      }],
      isError: true,
    };
  }
  return fail(error);
}

const expectedParam = z.string().nullable().optional()
  .describe('The updated_at from read_site_fields ("" or null when it was null: nothing saved yet). A save made in between is refused with 409.');

export const siteFieldTools: ToolDef[] = [
  {
    name: 'read_site_fields',
    description:
      'Read the site fields: the settings pages (groups with their field definitions), the saved values, updated_at and editable_groups (the groups whose values you may change with your permission). ' +
      'Read this before define_site_fields or update_site_fields and pass its updated_at as expected_updated_at. ' + SITE_FIELDS_MODEL,
    inputSchema: { version: versionParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.get(siteId, 'site-fields', v(args.version))); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'define_site_fields',
    description:
      'Replace the site\'s settings pages (all groups and their field definitions). Needs admin permission on the site. ' +
      'Send every group, including the ones you keep: a group or field left out is removed, and so is its value. Renaming a field is a removal plus an addition, so its value is lost; values that no longer fit a changed field type are dropped too (listed in dropped_values). ' +
      'Example: groups [{ id: "booking", label: "Booking", fields: [{ name: "show_booking", type: "boolean", label: "Show the booking calendar" }, { name: "delivery_days", type: "number", label: "Delivery days right now", min: 0 }] }, { id: "visit", label: "Visit us", fields: [{ name: "visiting_address", type: "textarea", label: "Visiting address", required: true }, <opening hours field> ] }]. ' +
      'Every save keeps the previous document as a revision; invalid definitions return `errors` with the path of each problem. Then fill in values with update_site_fields. ' + SITE_FIELDS_MODEL,
    inputSchema: {
      groups: z.array(z.object({
        id: z.string().describe('Lowercase letters, digits, - and _.'),
        label: z.string().describe('The settings page title the client sees.'),
        description: z.string().optional(),
        access: z.enum(['editor', 'admin']).optional().describe('Who may change the values. Default editor.'),
        fields: z.array(z.record(z.string(), z.unknown())).describe('Field definitions: { name, type, label, ... }.'),
      }).passthrough()).describe('Every settings page of the site, at most 20 with 200 fields in all.'),
      expected_updated_at: expectedParam,
      version: versionParam,
    },
    handler: async (args, { client, siteId }) => {
      try {
        return ok(await client.put(siteId, 'site-fields', { groups: args.groups, expected_updated_at: args.expected_updated_at }, v(args.version)));
      } catch (error) { return siteFieldsFailure(error, 'definitions'); }
    },
  },
  {
    name: 'update_site_fields',
    description:
      'Change site field values: send only the fields to change, by name; others keep their values, and null removes one. ' +
      'Example: { values: { show_booking: false, delivery_days: 3, opening_hours: { days: [...7 days], exceptions: [{ date: "2026-12-24", closed: true }] } } }. ' +
      'An object or list value is replaced as a whole. Values in groups with access "admin" need admin permission; the rest need write. ' +
      'Saved directly (not a draft), with the previous values kept as a revision; live at the next publication. Invalid values return `errors` with their paths. ' +
      'For the field model and how values show on the site, see read_site_fields.',
    inputSchema: {
      values: z.record(z.string(), z.unknown()).describe('Field name → new value; null removes the value.'),
      expected_updated_at: expectedParam,
      version: versionParam,
    },
    handler: async (args, { client, siteId }) => {
      try {
        return ok(await client.patch(siteId, 'site-fields', { values: args.values, expected_updated_at: args.expected_updated_at }, v(args.version)));
      } catch (error) { return siteFieldsFailure(error, 'values'); }
    },
  },
];
