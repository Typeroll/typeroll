// Form actions (email notifications, webhooks, app actions) for the v1 API
// and MCP. Same rules as the portal's Forms editor: admins read them with
// secrets masked and write them through the same validation.

import type { Form, FormAction } from '@typeroll/shared';
import { collectStepFields } from '@typeroll/shared';
import { maskFormActionsForAdmin, validateEmailActions } from './forms-admin';

/** Actions as an admin sees them (secrets masked); empty for other permissions, like the UI. */
export function formActionsView(form: Pick<Form, 'actions'>, permission: string): FormAction[] {
  return permission === 'admin' ? maskFormActionsForAdmin(form.actions) : [];
}

/** Validate incoming actions against the action registry and the form's own fields. */
export async function validateFormActionsInput(input: unknown, existing: FormAction[] | undefined, steps: Form['steps']): Promise<FormAction[] | string> {
  const { actionRegistry } = await import('./forms/actions');
  const webhookFields = (steps ?? []).flatMap((step) => collectStepFields(step.blocks)).map((field) => field.name);
  return validateEmailActions(input, [...(await actionRegistry()).keys()], existing ?? [], webhookFields);
}
