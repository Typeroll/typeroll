// Changing a block type that is in use.
//
// A schema change can rename, remove or retype fields. Every block that uses
// the type keeps its data under the old field names, so a change without a
// migration silently orphans content on every page that uses it.
//
// - Renames are explicit (`renames: { "old.path": "new_name" }`, dotted paths
//   of the OLD names, at any depth inside list and group fields). The data
//   moves in every instance: saved pages and their drafts, page templates,
//   headers, footers and global blocks (saved and draft), block templates,
//   and the compositions of other site block types. Repeater items rendered
//   with the type (`item_block`) move too.
// - Removing or retyping a field that holds data in any instance is refused
//   unless the caller confirms the loss; the data is then dropped.
//
// The pure half (plan, migrate a value, migrate a tree) is unit tested on its
// own; `applyBlockTypeChange` does the IO through the version chain and
// snapshots a revision of each page and global block it changes.

import type { Block, BlockTemplate, BlockType, BlockTypeProblem, FieldDefinition, FieldType, Page, Partial as PartialDoc, PageTemplate, WorkingCopy } from '@typeroll/shared';
import { vstore } from './version-store';
import { listWorkingCopies, mergeWorkingCopy } from './working-copy';
import { snapshotRevision } from './revisions';
import { listBlockTemplates, updateBlockTemplate } from './block-templates-store';
import { blockTypeResolver, itemBlockOf, type BlockTypeResolver } from './block-type-usage';
import type { WriteActor } from './field-authority';

export interface SchemaChangePlan {
  /** Dotted paths, old names → new names. */
  renamed: Array<{ from: string; to: string }>;
  /** Dotted paths (old names) of fields the new schema no longer has. */
  removed: string[];
  retyped: Array<{ path: string; from: FieldType; to: FieldType }>;
  /** Invalid renames; any problem refuses the change. */
  problems: BlockTypeProblem[];
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Type changes that keep stored values meaningful. */
const COMPATIBLE: Record<string, readonly FieldType[]> = {
  text: ['textarea', 'richtext', 'select'],
  textarea: ['text', 'richtext'],
  select: ['text'],
  page_ref: ['page_ref_list'],
  list_simple: ['list'],
};
const compatible = (from: FieldType, to: FieldType) => from === to || (COMPATIBLE[from] ?? []).includes(to);
const isGroup = (field: FieldDefinition) => field.type === 'array' || field.type === 'object';

/** True when the change touches data at all (renames, removals or retypes). */
export function planChangesData(plan: SchemaChangePlan): boolean {
  return plan.renamed.length > 0 || plan.removed.length > 0 || plan.retyped.length > 0;
}

/**
 * Compare two schemas, with explicit renames, into what happens to stored
 * data. `renames` keys are dotted paths of old field names; values are the new
 * name of that field (not a path).
 */
export function planSchemaChange(
  oldSchema: readonly FieldDefinition[],
  newSchema: readonly FieldDefinition[],
  renames: Record<string, string> = {},
): SchemaChangePlan {
  const plan: SchemaChangePlan = { renamed: [], removed: [], retyped: [], problems: [] };
  const used = new Set<string>();
  const problem = (key: string, message: string) => plan.problems.push({ severity: 'error', path: `/renames/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, message });
  for (const [key, value] of Object.entries(renames)) {
    if (typeof value !== 'string' || !FIELD_NAME.test(value)) problem(key, `The new name for "${key}" must be lowercase letters, digits and "_", starting with a letter.`);
  }
  const walk = (oldFields: readonly FieldDefinition[], newFields: readonly FieldDefinition[], oldPrefix: string, newPrefix: string) => {
    const claimed = new Map<string, string>();
    // Names another field at this level is renamed to (a swap frees the old name).
    const targets = new Set(oldFields.map(field => renames[`${oldPrefix}${field.name}`]).filter(Boolean));
    for (const field of oldFields) {
      const oldPath = `${oldPrefix}${field.name}`;
      used.add(oldPath);
      const requested = renames[oldPath];
      const newName = typeof requested === 'string' && FIELD_NAME.test(requested) ? requested : field.name;
      if (requested !== undefined && requested !== field.name && !targets.has(field.name) && newFields.some(candidate => candidate.name === field.name)) {
        problem(oldPath, `"${oldPath}" is renamed to "${requested}" but the new schema still has "${field.name}".`);
        continue;
      }
      const next = newFields.find(candidate => candidate.name === newName);
      if (!next) {
        if (requested !== undefined) problem(oldPath, `"${oldPath}" is renamed to "${requested}", which the new schema does not have.`);
        else plan.removed.push(oldPath);
        continue;
      }
      if (claimed.has(newName)) {
        problem(oldPath, `"${oldPath}" and "${claimed.get(newName)}" would both become "${newPrefix}${newName}".`);
        continue;
      }
      claimed.set(newName, oldPath);
      if (newName !== field.name) plan.renamed.push({ from: oldPath, to: `${newPrefix}${newName}` });
      if (!compatible(field.type, next.type)) {
        plan.retyped.push({ path: oldPath, from: field.type, to: next.type });
        continue;
      }
      if (isGroup(field) && isGroup(next)) walk(field.fields ?? [], next.fields ?? [], `${oldPath}.`, `${newPrefix}${newName}.`);
    }
  };
  walk(oldSchema, newSchema, '', '');
  for (const key of Object.keys(renames)) if (!used.has(key)) problem(key, `"${key}" names no field of the current schema.`);
  return plan;
}

const hasData = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface PropsMigration {
  value: Record<string, unknown>;
  changed: boolean;
  /** Old dotted paths whose data this change drops. */
  lost: string[];
}

/**
 * Apply a plan to one set of props (a block's data, a repeater item, a
 * responsive override). Keys the old schema does not know are kept as is.
 */
export function migrateProps(value: Record<string, unknown>, oldSchema: readonly FieldDefinition[], plan: SchemaChangePlan): PropsMigration {
  const renamed = new Map(plan.renamed.map(entry => [entry.from, entry.to.split('.').pop()!]));
  const dropped = new Set([...plan.removed, ...plan.retyped.map(entry => entry.path)]);
  const lost = new Set<string>();
  let changed = false;
  const visit = (props: Record<string, unknown>, fields: readonly FieldDefinition[], prefix: string): Record<string, unknown> => {
    const known = new Set(fields.map(field => field.name));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(props)) if (!known.has(key)) out[key] = entry;
    for (const field of fields) {
      if (!Object.hasOwn(props, field.name)) continue;
      const path = `${prefix}${field.name}`;
      let entry = props[field.name];
      if (dropped.has(path)) {
        if (hasData(entry)) lost.add(path);
        changed = true;
        continue;
      }
      if (field.type === 'array' && Array.isArray(entry) && field.fields?.length) {
        entry = entry.map(item => (isRecord(item) ? visit(item, field.fields!, `${path}.`) : item));
      } else if (field.type === 'object' && isRecord(entry) && field.fields?.length) {
        entry = visit(entry, field.fields, `${path}.`);
      }
      const name = renamed.get(path) ?? field.name;
      if (name !== field.name) changed = true;
      out[name] = entry;
    }
    return out;
  };
  const next = visit(value, oldSchema, '');
  return { value: changed ? next : value, changed, lost: [...lost].sort() };
}

export interface TreeMigration {
  blocks: Block[];
  changed: boolean;
  /** Blocks of the type plus repeater items rendered with it. */
  instances: number;
  lost: string[];
}

/**
 * Apply a plan to every instance of `typeId` in a block tree: blocks of the
 * type (data and responsive overrides) and static repeater items rendered
 * with it as `item_block`. Returns a new tree; the input is not modified.
 */
export function migrateTree(
  blocks: readonly Block[],
  typeId: string,
  oldSchema: readonly FieldDefinition[],
  plan: SchemaChangePlan,
  resolve?: BlockTypeResolver,
): TreeMigration {
  let changed = false;
  let instances = 0;
  const lost = new Set<string>();
  const apply = (props: Record<string, unknown>) => {
    const result = migrateProps(props, oldSchema, plan);
    if (result.changed) changed = true;
    for (const path of result.lost) lost.add(path);
    return result.value;
  };
  const visit = (block: Block): Block => {
    if (!block || typeof block !== 'object') return block;
    let next: Block = block;
    if (block.type === typeId) {
      instances++;
      next = { ...next, data: apply(isRecord(block.data) ? block.data : {}) };
      if (isRecord(block.responsive)) {
        next.responsive = Object.fromEntries(Object.entries(block.responsive).map(([breakpoint, override]) =>
          [breakpoint, isRecord(override) ? apply(override) : override])) as Block['responsive'];
      }
    }
    if (itemBlockOf(block, resolve) === typeId && Array.isArray(block.data?.items)) {
      const items = (block.data.items as unknown[]).map(item => {
        if (!isRecord(item)) return item;
        instances++;
        return apply(item);
      });
      next = { ...next, data: { ...next.data, items } };
    }
    if (block.children) next = { ...next, children: block.children.map(visit) };
    if (block.slots) next = { ...next, slots: block.slots.map(slot => slot.map(visit)) };
    return next;
  };
  const out = blocks.map(visit);
  return { blocks: changed ? out : [...blocks], changed, instances, lost: [...lost].sort() };
}

/**
 * Rewrite a composed type's own bindings after renaming its props:
 * `{{props.old}}` → `{{props.new}}`, and `{{item.old}}` inside a repeater
 * looping over a renamed list's items.
 */
export function renameCompositionBindings(composition: readonly Block[], plan: SchemaChangePlan): Block[] {
  if (!plan.renamed.length) return [...composition];
  const renamed = new Map(plan.renamed.map(entry => [entry.from, entry.to]));
  /** New dotted path for an old dotted path, renaming each segment that moved. */
  const mapPath = (oldPath: string): string => {
    const parts = oldPath.split('.');
    const out: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join('.');
      const target = renamed.get(prefix);
      out.push(target ? target.split('.').pop()! : parts[index]!);
    }
    return out.join('.');
  };
  const BINDING = /^(\s*\{\{\s*)(props|item)\.([\w.-]+)(\s*\}\}\s*)$/;
  const visit = (block: Block, listPath: string | undefined): Block => {
    let itemList = listPath;
    const data: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(block.data ?? {})) {
      const match = typeof raw === 'string' ? BINDING.exec(raw) : null;
      if (!match) { data[key] = raw; continue; }
      const [, open, namespace, path, close] = match;
      const oldPath = namespace === 'props' ? path! : listPath ? `${listPath}.${path}` : undefined;
      if (!oldPath) { data[key] = raw; continue; }
      const mapped = mapPath(oldPath);
      const relative = namespace === 'props' ? mapped : mapped.split('.').slice(listPath!.split('.').length).join('.');
      data[key] = `${open}${namespace}.${relative}${close}`;
      if (block.type === 'core/repeater' && key === 'items') itemList = oldPath;
    }
    return {
      ...block,
      data,
      ...(block.children ? { children: block.children.map(child => visit(child, block.type === 'core/repeater' ? itemList : listPath)) } : {}),
      ...(block.slots ? { slots: block.slots.map(slot => slot.map(child => visit(child, listPath))) } : {}),
    };
  };
  return composition.map(block => visit(block, undefined));
}

// ─── IO ───────────────────────────────────────────────────────────────────

export interface MigrationCtx { orgId: string; siteId: string; versionId: string }

export type UsageKind = 'page' | 'page_draft' | 'page_template' | 'partial' | 'partial_draft' | 'block_template' | 'block_type';

export interface ImpactUsage {
  kind: UsageKind;
  id: string;
  title: string;
  instances: number;
  /** Old dotted paths whose data the change drops here. */
  data_loss: string[];
}

export interface BlockTypeImpact {
  usages: ImpactUsage[];
  renamed: SchemaChangePlan['renamed'];
  removed: string[];
  retyped: SchemaChangePlan['retyped'];
  /** Places that could not be updated (e.g. a page changed concurrently). */
  failed?: Array<{ kind: UsageKind; id: string; error: string }>;
}

interface Target {
  kind: UsageKind;
  id: string;
  title: string;
  migration: TreeMigration;
  write: (blocks: Block[]) => Promise<void>;
}

export interface ApplyOptions {
  /** False computes the impact only. */
  apply: boolean;
  actor: WriteActor;
  actorId: string;
}

/**
 * Find every instance of `type` on the site version and, when `apply` is
 * set, move its data according to `plan`. Revisions are snapshotted for each
 * saved page and global block that changes.
 */
export async function applyBlockTypeChange(
  ctx: MigrationCtx,
  type: BlockType,
  plan: SchemaChangePlan,
  options: ApplyOptions,
): Promise<BlockTypeImpact> {
  const { orgId, siteId, versionId } = ctx;
  const [pages, templates, partials, siteTypes, workingCopies, blockTemplates] = await Promise.all([
    vstore.pages(orgId, siteId, versionId) as Promise<Page[]>,
    vstore.pageTemplates(orgId, siteId, versionId) as Promise<PageTemplate[]>,
    vstore.partials(orgId, siteId, versionId) as Promise<PartialDoc[]>,
    vstore.blockTypes(orgId, siteId, versionId),
    listWorkingCopies(ctx).catch(() => [] as WorkingCopy[]),
    listBlockTemplates(ctx).catch(() => [] as BlockTemplate[]),
  ]);
  const resolve = blockTypeResolver(siteTypes);
  const migrate = (blocks: Block[] | undefined) => migrateTree(blocks ?? [], type.id, type.schema ?? [], plan, resolve);
  const note = `Block type "${type.id}" changed`;
  const targets: Target[] = [];

  for (const page of pages) {
    if (page.content_mode === 'blocks' && Array.isArray(page.blocks)) {
      targets.push({ kind: 'page', id: page.id, title: page.title, migration: migrate(page.blocks), write: async blocks => {
        await snapshotRevision({ orgId, siteId, versionId, kind: 'page', resourceIds: [page.id], doc: page as unknown as Record<string, unknown>, createdBy: options.actorId, note });
        await vstore.writePage(orgId, siteId, versionId, page.id, { blocks }, { actor: options.actor, actorId: options.actorId });
      } });
    }
  }
  for (const partial of partials) {
    if (Array.isArray(partial.blocks)) {
      targets.push({ kind: 'partial', id: partial.id, title: partial.name ?? partial.id, migration: migrate(partial.blocks), write: async blocks => {
        await snapshotRevision({ orgId, siteId, versionId, kind: 'partial', resourceIds: [partial.id], doc: partial as unknown as Record<string, unknown>, createdBy: options.actorId, note });
        await vstore.writePartial(orgId, siteId, versionId, partial.id, { blocks, date_updated: new Date().toISOString() });
      } });
    }
  }
  for (const wc of workingCopies) {
    if ((wc.kind !== 'page' && wc.kind !== 'partial') || !Array.isArray(wc.fields?.blocks)) continue;
    const owner = wc.kind === 'page' ? pages.find(page => page.id === wc.target_id) : partials.find(partial => partial.id === wc.target_id);
    const title = owner ? ('title' in owner ? owner.title : owner.name) : wc.target_id;
    targets.push({ kind: wc.kind === 'page' ? 'page_draft' : 'partial_draft', id: wc.target_id, title, migration: migrate(wc.fields.blocks as Block[]), write: async blocks => {
      await mergeWorkingCopy(ctx, { kind: wc.kind as 'page' | 'partial', id: wc.target_id }, { blocks }, wc.updated_by);
    } });
  }
  for (const template of templates) {
    targets.push({ kind: 'page_template', id: template.id, title: template.label || template.name || template.id, migration: migrate(template.blocks), write: async blocks => {
      await vstore.writePageTemplate(orgId, siteId, versionId, template.id, { blocks });
    } });
  }
  for (const template of blockTemplates) {
    targets.push({ kind: 'block_template', id: template.id, title: template.name, migration: migrate(template.blocks), write: async blocks => {
      await updateBlockTemplate(ctx, template.id, { blocks });
    } });
  }
  for (const other of siteTypes) {
    if (other.id === type.id || !other.composition?.length) continue;
    targets.push({ kind: 'block_type', id: other.id, title: other.label ?? other.id, migration: migrate(other.composition), write: async blocks => {
      await vstore.writeBlockType(orgId, siteId, versionId, other.id, { composition: blocks, updated_at: new Date().toISOString() } as Partial<BlockType>);
    } });
  }

  const used = targets.filter(target => target.migration.instances > 0);
  const impact: BlockTypeImpact = {
    usages: used.map(target => ({ kind: target.kind, id: target.id, title: target.title, instances: target.migration.instances, data_loss: target.migration.lost })),
    renamed: plan.renamed,
    removed: plan.removed,
    retyped: plan.retyped,
  };
  if (!options.apply) return impact;
  const failed: NonNullable<BlockTypeImpact['failed']> = [];
  for (const target of used) {
    if (!target.migration.changed) continue;
    try {
      await target.write(target.migration.blocks);
    } catch (error) {
      failed.push({ kind: target.kind, id: target.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length) impact.failed = failed;
  return impact;
}

/** Usages where the change drops data. */
export function dataLossUsages(impact: BlockTypeImpact): ImpactUsage[] {
  return impact.usages.filter(usage => usage.data_loss.length > 0);
}
