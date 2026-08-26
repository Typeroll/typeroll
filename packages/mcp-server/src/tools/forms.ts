// Forms — agents can create/update/delete forms, and read submissions.
// The customer-facing submit endpoint is HMAC-signed and lives at
// /api/forms/submit. Agents place forms by reference: core/form in block mode,
// or <x-form id="…" /> in HTML mode. Preview/build expands either reference
// through the same trusted renderer with token, initial state, and runtime.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

const fieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  type: z.enum([
    'text', 'email', 'tel', 'url', 'number', 'textarea',
    'select', 'checkbox', 'radio', 'hidden', 'gdpr_consent',
  ]),
  label: z.string(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional().describe('Required for type "select" and "radio".'),
  default: z.unknown().optional(),
});

// Forms 2.0 funnel step. `blocks` is a form/* block tree (form/text,
// form/email, form/select, form/consent, … — same shapes add_block uses);
// non-form blocks (core/prose, form/heading, form/help) are allowed for
// copy between fields. Steps swap client-side with no server round-trip.
const stepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  title: z.string().optional(),
  render: z.enum(['static', 'dynamic']).optional()
    .describe("Default 'static' (prerendered). 'dynamic' is reserved for app-computed steps."),
  next: z.string().optional().describe('Next step id. Default: next in list; last step submits.'),
  blocks: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const formTools: ToolDef[] = [
  {
    name: 'list_forms',
    description: 'List every form defined on the site with its full field schema.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'forms');
      return ok(res);
    }),
  },
  {
    name: 'read_form',
    description:
      'Read one form by id, including fields/steps, submit_text, and success_message. Place it with a `core/form` block using data.form_id on a block-mode page, or `<x-form id="…" />` in HTML mode. Both references are expanded server-side with validation, signed token, initial state, and the shared runtime.',
    inputSchema: { form_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `forms/${encodeURIComponent(args.form_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'create_form',
    description:
      'Create a form. Steps are the ONLY stored model — a Block[] tree of form/* field blocks per step. Simple forms: pass `fields`, each { name, type, label, required?, placeholder?, options? } (allowed types: text, email, tel, url, number, textarea, select, checkbox, radio, hidden, gdpr_consent) — the server converts them to a single static step; read_form returns the resulting steps. Multi-step funnels: pass `steps` directly (steps swap client-side, partial submissions persist per step). PLACING THE FORM: add a `core/form` block with data.form_id on block-mode pages, or `<x-form id="…" />` to HTML-mode page content. Both expand server-side to the same complete signed shell; never hand-write the form or add inline submit scripts.',
    inputSchema: {
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
      name: z.string().min(1),
      fields: z.array(fieldSchema).min(1).optional(),
      steps: z.array(stepSchema).min(1).optional(),
      submit_text: z.string().optional(),
      success_message: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      if (!args.fields && !args.steps) {
        return ok({ error: 'Provide `fields` (simple form) or `steps` (multi-step funnel).' });
      }
      const res = await client.post(siteId, 'forms', args);
      return ok(res);
    }),
  },
  {
    name: 'update_form',
    description:
      'Patch a form. Provide only what you want to change. Passing `steps` replaces the whole step list; passing `fields` (sugar for simple forms) replaces the whole step list with ONE static step built from them. The existing form_id is immutable.',
    inputSchema: {
      form_id: z.string(),
      patch: z.object({
        name: z.string().optional(),
        fields: z.array(fieldSchema).optional(),
        steps: z.array(stepSchema).optional(),
        submit_text: z.string().optional(),
        success_message: z.string().optional(),
      }),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.patch(
        siteId,
        `forms/${encodeURIComponent(args.form_id)}`,
        args.patch,
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_form',
    description:
      'Delete a form. Existing submissions are preserved by default — pass delete_submissions: true to also drop them.',
    inputSchema: {
      form_id: z.string(),
      delete_submissions: z.boolean().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `forms/${encodeURIComponent(args.form_id)}`,
        args.delete_submissions ? { delete_submissions: 'true' } : undefined,
      );
      return ok(res);
    }),
  },
  {
    name: 'list_form_submissions',
    description:
      'List submissions received for a form, newest first, cursor-paginated (cap 200 per page). Use this to help a customer triage inbound contact / lead submissions.',
    inputSchema: {
      form_id: z.string(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { form_id, ...query } = args;
      const res = await client.get(
        siteId,
        `forms/${encodeURIComponent(form_id)}/submissions`,
        query,
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_form_submission',
    description:
      'Delete a single submission from a form\'s inbox. Use this to remove individual entries (test submissions, spam) without touching the rest — delete_form with delete_submissions is the only way to bulk-delete. Get submission ids from list_form_submissions.',
    inputSchema: {
      form_id: z.string(),
      submission_id: z.string(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(
        siteId,
        `forms/${encodeURIComponent(args.form_id)}/submissions/${encodeURIComponent(args.submission_id)}`,
      );
      return ok(res);
    }),
  },
];
