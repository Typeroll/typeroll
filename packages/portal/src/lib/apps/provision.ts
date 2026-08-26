// Provisioning: what appears on a site when an app is switched on.
//
// The model this implements — an app SHIPS forms; enabling it makes them
// placeable as blocks; the site EXTENDS their fields; the app owns what
// happens on submit.
//
// The mechanism is deliberately boring. Rather than teaching the renderer,
// the preview, the editor's block picker, the agent's list_block_types and
// materializeFixtures each to merge in "app blocks", enabling an app WRITES
// its block types into the site's own `block_types` collection. Every one of
// those surfaces already reads that collection, so they all pick the blocks up
// with no change at all. The same goes for forms: an app form is seeded as a
// real Form doc, so the existing forms UI edits it like any other.
//
// Two rules that make the toggle safe to flip:
//
//   Seeding never overwrites. A form the site has already extended keeps its
//   fields when the app is re-enabled, or the toggle would silently discard
//   the operator's work.
//
//   Disabling removes the BLOCKS but keeps the FORMS. Blocks are pure app
//   surface and should disappear from the picker; a form may carry fields the
//   site added and pages that reference it, and deleting user content on a
//   settings toggle is not a thing a settings toggle should do.

import { fieldsToSteps, paths } from '@typeroll/shared';
import type { BlockType, Form, FormField } from '@typeroll/shared';
import { getStore } from '../datastore';
import type { AppDef, AppFormDef } from './types';

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';

/** Stable ids so re-enabling finds what it seeded rather than duplicating it. */
export function appFormId(appId: string, formId: string): string {
  return `${appId}--${formId}`;
}
export function appBlockTypeId(appId: string, formId: string): string {
  return `${appId}/${formId}_form`;
}

/**
 * The block that places one app form. An alias onto `core/form` with the
 * seeded form's id baked in, so the person placing it picks a labelled block
 * ("Edit listing") rather than having to know a form id.
 */
export function appFormBlockType(appId: string, form: AppFormDef): BlockType {
  return {
    id: appBlockTypeId(appId, form.id),
    name: `${form.id}_form`,
    label: form.label,
    icon: form.icon ?? '📝',
    category: 'content',
    container: false,
    description: form.description,
    schema: [],
    expand_to: { target: 'core/form', defaults: { form_id: appFormId(appId, form.id) } },
    template: '',
    origin: 'third_party',
    created_at: ISO_EPOCH,
  } as BlockType;
}

function seedForm(appId: string, def: AppFormDef): Omit<Form, 'id'> {
  return {
    name: def.name,
    actions: def.actions ?? [],
    prefill: def.prefill ?? [],
    submit_text: def.submit_text,
    success_message: def.success_message,
    steps: fieldsToSteps(def.fields as FormField[]),
    target: def.target,
    created_at: new Date().toISOString(),
  } as Omit<Form, 'id'>;
}

export interface ProvisionResult {
  forms_created: string[];
  forms_kept: string[];
  blocks_written: string[];
  blocks_removed: string[];
}

/**
 * Bring a site's app-provided surface in line with the app's enabled state.
 * Idempotent: safe to call on every settings save.
 */
export async function provisionApp(
  orgId: string,
  siteId: string,
  def: AppDef,
  enabled: boolean,
  versionId = 'main',
): Promise<ProvisionResult> {
  const store = getStore();
  const out: ProvisionResult = {
    forms_created: [], forms_kept: [], blocks_written: [], blocks_removed: [],
  };
  const forms = def.forms ?? [];
  const blocks = [
    ...forms.map((f) => appFormBlockType(def.id, f)),
    ...(def.blocks ?? []),
  ];

  if (!enabled) {
    for (const bt of blocks) {
      try {
        await store.deleteDoc(paths.blockType(orgId, siteId, bt.id, versionId));
        out.blocks_removed.push(bt.id);
      } catch { /* absent is the desired state either way */ }
    }
    return out;
  }

  for (const f of forms) {
    const id = appFormId(def.id, f.id);
    const existing = await store.getDoc<Form>(`${paths.forms(orgId, siteId)}/${id}`);
    if (existing) {
      // Already there — the site may have added fields to it. Leave it alone.
      out.forms_kept.push(id);
      continue;
    }
    await store.setDoc(`${paths.forms(orgId, siteId)}/${id}`, seedForm(def.id, f));
    out.forms_created.push(id);
  }

  for (const bt of blocks) {
    // Block types ARE app surface — rewritten on every enable so a platform
    // update to the block reaches sites that already had it.
    const { id: _id, ...body } = bt;
    await store.setDoc(paths.blockType(orgId, siteId, bt.id, versionId), body);
    out.blocks_written.push(bt.id);
  }
  return out;
}
