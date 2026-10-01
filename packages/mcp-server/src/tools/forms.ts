// Forms — agents can create/update/delete forms, manage their email
// notifications and webhooks, and read submissions, like the portal.
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
    'select', 'checkbox', 'boolean', 'radio', 'hidden', 'gdpr_consent',
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

const targetSchema = z.object({
  context_params: z.array(z.string()).max(8).optional().describe('Explicit URL query keys forwarded to the app hydration endpoint; reserved security keys are rejected.'),
  installation_id: z.string(), path: z.string(), hydrate: z.boolean().optional(), session_param: z.string().optional(),
}).optional().describe('Admin-only: bind to a declared POST route of an enabled app installation. Read its authenticated guide first.');

// Actions run after a successful submission: email notifications, signed
// webhooks and app-provided action types. Same validation as the portal's
// Forms editor; admin permission required, as in the portal.
const actionSchema = z.object({
  id: z.string().optional().describe('Keep an existing action\'s id to update it in place (webhooks keep their stored secret).'),
  type: z.string().describe('"email", "webhook", or an action type provided by an installed app.'),
  config: z.record(z.string(), z.unknown()).describe(
    'email: { to, subject, body, cc?, bcc?, reply_to?, include_all?, format?: "html"|"text" } — to/subject/body may use {{field}} placeholders, e.g. to: "{{email}}" for a confirmation to the visitor. ' +
    'webhook: { url (https), fields: ["name","email"] (only these values are sent), secret (signing secret; send "••••••••" to keep the stored one) }.',
  ),
});
const actionsDescription = 'The complete list of actions after a submission (replaces the current list): email notifications, webhooks, app actions. Read the form first and send back the actions you keep. Requires admin permission, like the portal.';

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
      'Read one form by id, including fields/steps, submit_text, success_message and, for admins, its actions (email notifications and webhooks; secrets masked). Place it with a `core/form` block using data.form_id on a block-mode page, or `<x-form id="…" />` in HTML mode. Both references are expanded server-side with validation, signed token, initial state, and the shared runtime.',
    inputSchema: { form_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `forms/${encodeURIComponent(args.form_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'create_form',
    description:
      'Create a form. Steps are the ONLY stored model — a Block[] tree of form/* field blocks per step. Simple forms: pass `fields`, each { name, type, label, required?, placeholder?, options? } (allowed types: text, email, tel, url, number, textarea, select, checkbox, boolean (Yes/No/unanswered), radio, hidden, gdpr_consent) — the server converts them to a single static step; read_form returns the resulting steps. Multi-step funnels: pass `steps` directly (steps swap client-side, partial submissions persist per step). PLACING THE FORM: add a `core/form` block with data.form_id on block-mode pages, or `<x-form id="…" />` to HTML-mode page content. Both expand server-side to the same complete signed shell; never hand-write the form or add inline submit scripts.',
    inputSchema: {
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
      name: z.string().min(1),
      fields: z.array(fieldSchema).min(1).optional(),
      steps: z.array(stepSchema).min(1).optional(),
      submit_text: z.string().optional(),
      success_message: z.string().optional().describe('Shown after the final step. May contain basic HTML (links, emphasis); it is sanitized.'),
      success_redirect_url: z.string().optional().describe('After the final step, send the visitor to this absolute http(s) URL or root-relative path (for example a booking or thank-you page) instead of showing success_message. Pass an empty string to clear.'),
      actions: z.array(actionSchema).optional().describe(actionsDescription),
      target: targetSchema,
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
      'Patch a form. Provide only what you want to change. Passing `steps` replaces the whole step list; passing `fields` (sugar for simple forms) replaces the whole step list with ONE static step built from them. Passing `actions` replaces the email notifications and webhooks (admin). The existing form_id is immutable.',
    inputSchema: {
      form_id: z.string(),
      patch: z.object({
        name: z.string().optional(),
        fields: z.array(fieldSchema).optional(),
        steps: z.array(stepSchema).optional(),
        submit_text: z.string().optional(),
        success_message: z.string().optional().describe('Shown after the final step. May contain basic HTML (links, emphasis); it is sanitized.'),
        success_redirect_url: z.string().optional().describe('After the final step, send the visitor to this absolute http(s) URL or root-relative path (for example a booking or thank-you page) instead of showing success_message. Pass an empty string to clear.'),
        actions: z.array(actionSchema).optional().describe(actionsDescription),
        target: targetSchema,
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
