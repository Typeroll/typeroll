// Form actions — what happens after a form is submitted.
//
// `Form.actions` is a list of `{ type, config }`, and this is the registry
// that turns a type into behaviour. The point is COMPOSITION: one form's
// actions can come from several sources at once. A directory listing edit
// might send a confirmation email (core), post to Slack (a Slack app), and
// enqueue a moderation task (the directory app) — three actions, three
// owners, one list.
//
// So the action a form runs is decoupled from the endpoint it posts to. The
// directory's edit endpoint doesn't know what an email is; it writes the
// listing and then asks this registry to run whatever the form declared.
//
// Registering: core types are added below; an app adds its own by declaring
// `AppDef.actions`, which the registry picks up. Nothing needs a branch here
// for a new action type or a new app.

import { paths } from '@typeroll/shared';
import type { EmailActionConfig, EmailConnector, Form, FormAction, SiteIntegrations } from '@typeroll/shared';
import type { AppConfigField } from '../apps/types';
import { getStore } from '../datastore';
import { buildEmailMessage } from '../email/render-email';
import { sendViaConnector } from '../email';

export interface ActionContext {
  orgId: string;
  siteId: string;
  /** Form id for submission actions. */
  formId?: string;
  /** Field values submitted, for `{{token}}` interpolation in action config. */
  data: Record<string, unknown>;
  /** What the submission was about, when the action's source cares. */
  subject?: { kind: 'submission' | 'collection_item'; collection?: string; id?: string };
}

export interface FormActionDef {
  /** `Form.actions[].type` this handles. Namespaced for app-provided ones. */
  type: string;
  /** Human label for the form editor's action picker. */
  label: string;
  description?: string;
  /**
   * Config schema, so the form editor can render ANY action type without
   * knowing it. Without this the editor could only ever handle the types it
   * was hand-coded for — which is how it ended up email-only.
   */
  config_fields?: AppConfigField[];
  /**
   * Admin-only actions are never writable through the chat AI or MCP — an
   * action carrying a recipient address is an exfiltration vector if a model
   * can set it. `email` is the reason this flag exists.
   */
  admin_only?: boolean;
  /**
   * Runs BEFORE the form's own effect (storing a submission, writing a
   * listing). Returning `{ reject }` aborts the submit and surfaces the
   * message to the visitor — the one place a form action can say no.
   *
   * Deliberately separate from `run`: pre-submit failures MUST be visible
   * (they change the outcome), while post-submit failures are swallowed
   * (the thing already happened). Folding both into one hook would mean a
   * bounced confirmation email could roll back a saved listing.
   */
  before?: (action: FormAction, ctx: ActionContext) => Promise<void | { reject: string }>;
  run: (action: FormAction, ctx: ActionContext) => Promise<void>;
}

const CORE_ACTIONS: FormActionDef[] = [
  {
    type: 'email',
    label: 'Send an email',
    description: 'Notify someone, or send the visitor a confirmation.',
    admin_only: true,
    config_fields: [
      { key: 'to', label: 'To', type: 'text', required: true, help: 'Supports {{field}} — e.g. {{email}} for an autoresponder.' },
      { key: 'subject', label: 'Subject', type: 'text', required: true },
      { key: 'body', label: 'Body', type: 'text', required: true },
      { key: 'include_all', label: 'Append all submitted values', type: 'boolean', default: true },
    ],
    run: async (action, ctx) => {
      const integrations = await getStore().getDoc<SiteIntegrations>(
        paths.integrations(ctx.orgId, ctx.siteId),
      );
      const connector: EmailConnector | undefined = integrations?.email;
      if (!connector) {
        console.warn(`[form action] email skipped — no connector for site ${ctx.siteId}`);
        return;
      }
      const { message, error } = buildEmailMessage(
        action.config as unknown as EmailActionConfig,
        ctx.data,
        connector,
      );
      if (error || !message) {
        console.error('[form action] email not built:', error);
        return;
      }
      await sendViaConnector(connector, message);
    },
  },
  {
    type: 'webhook',
    label: 'Send a webhook',
    description: 'Send selected submitted fields to an external HTTPS endpoint.',
    admin_only: true,
    config_fields: [
      { key: 'url', label: 'Endpoint URL', type: 'text', required: true, placeholder: 'https://example.com/webhooks/typeroll' },
      { key: 'fields', label: 'Fields', type: 'text', required: true, help: 'Comma-separated allowlist, for example: email, first_name' },
      { key: 'secret', label: 'Signing secret', type: 'password', secret: true, required: true, help: 'Used for the X-Typeroll-Signature HMAC header.' },
    ],
    run: async (action, ctx) => {
      const { deliverFormWebhook } = await import('./webhook');
      await deliverFormWebhook(action, ctx);
    },
  },
];

let registry: Map<string, FormActionDef> | null = null;

/**
 * Core types plus every type the enabled apps contribute.
 *
 * Async because the apps registry is imported dynamically — AppDef references
 * FormActionDef from this module, so a static import would be a cycle. It has
 * to be `await import`, never `require`: this is ESM, and a runtime require
 * is the exact pattern that once took the hosted MCP route down.
 */
export async function actionRegistry(): Promise<Map<string, FormActionDef>> {
  if (registry) return registry;
  registry = new Map(CORE_ACTIONS.map((a) => [a.type, a]));
  const { listAppDefs } = await import('../apps/registry');
  for (const app of listAppDefs()) {
    for (const a of app.actions ?? []) {
      // First registration wins, so an app can't shadow a core action type
      // and quietly change what "email" means on every form.
      if (!registry.has(a.type)) registry.set(a.type, a);
    }
  }
  return registry;
}

export function _resetActionRegistryForTests(): void {
  registry = null;
}

/** Action types a non-admin surface (chat, MCP) may write. */
export async function agentWritableActionTypes(): Promise<string[]> {
  return [...(await actionRegistry()).values()]
    .filter((a) => !a.admin_only).map((a) => a.type);
}

/**
 * Run a form's actions.
 *
 * Every failure is swallowed per-action: the thing the form was FOR has
 * already happened (a submission stored, a listing updated) before this runs,
 * and a bounced email must never turn that into an error the visitor sees.
 * One action failing also mustn't stop the next — they have different owners.
 */
export async function runFormActions(
  form: Pick<Form, 'actions'>,
  ctx: ActionContext,
): Promise<{ ran: string[]; failed: string[] }> {
  const reg = await actionRegistry();
  const ran: string[] = [];
  const failed: string[] = [];
  for (const action of form.actions ?? []) {
    const def = reg.get(action.type);
    if (!def) {
      // An action whose app was disabled, or a type from a newer release.
      console.warn(`[form action] no handler for type "${action.type}"`);
      continue;
    }
    try {
      await def.run(action, ctx);
      ran.push(action.type);
    } catch (e) {
      failed.push(action.type);
      console.error(`[form action] "${action.type}" failed:`, e);
    }
  }
  return { ran, failed };
}

/**
 * Pre-submit pass. Any action returning `{ reject }` stops the submit — and
 * unlike `runFormActions`, a THROWN error also rejects rather than being
 * swallowed: a moderation check that crashes must not be read as approval.
 */
export async function runBeforeActions(
  form: Pick<Form, 'actions'>,
  ctx: ActionContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reg = await actionRegistry();
  for (const action of form.actions ?? []) {
    const def = reg.get(action.type);
    if (!def?.before) continue;
    try {
      const verdict = await def.before(action, ctx);
      if (verdict && 'reject' in verdict) return { ok: false, reason: verdict.reject };
    } catch (e) {
      console.error(`[form action] before "${action.type}" failed:`, e);
      return { ok: false, reason: 'This submission could not be processed. Please try again.' };
    }
  }
  return { ok: true };
}
