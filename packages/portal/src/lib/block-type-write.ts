// The one write path for site block types.
//
// The portal session routes, the v1 API (and through it MCP), the chat and
// package import all create, update and delete block types here, through the
// shared validator (@typeroll/shared block-type-definition.ts) and the
// version chain. Callers differ only in who they are:
//
// - `origin` stamps who authored the type (user, ai, third_party);
// - `allowScript` says whether the caller may write `script` (API keys and
//   portal admins may; the chat never does, see lib/block-script-gate.ts);
// - `actor` and `actorId` attribute the page writes a rename makes.
//
// Permission (admin on the site) is checked by each route before calling in.

import {
  BLOCK_TYPE_STARTERS,
  buildCoreBlockRegistry,
  sampleBlockData,
  scopeBlockCss,
  validateBlockTypeDefinition,
  type BlockOrigin,
  type BlockType,
  type BlockTypeProblem,
  type FieldDefinition,
} from '@typeroll/shared';
import { vstore } from './version-store';
import { blockTypeResolver, describeBlockTypeUsage, getBlockTypeUsage, usageCount, type BlockTypeUsage } from './block-type-usage';
import {
  applyBlockTypeChange,
  dataLossUsages,
  planChangesData,
  planSchemaChange,
  renameCompositionBindings,
  type BlockTypeImpact,
  type SchemaChangePlan,
} from './block-type-migration';
import type { WriteActor } from './field-authority';

export interface BlockTypeCtx { orgId: string; siteId: string; versionId: string }

export const BLOCK_TYPE_ADMIN_REQUIRED = 'Creating, changing, deleting and importing block types requires admin permission on the site.';

/** A stored site block type; `updated_at` is stamped on every write. */
export type StoredBlockType = BlockType & { updated_at?: string };

/**
 * Properties the server manages. A definition read from the API and sent back
 * (the builder's JSON view, an agent round-tripping read_block_type) carries
 * them; they are ignored rather than refused.
 */
const SERVER_MANAGED = ['id', 'origin', 'created_at', 'updated_at', 'created_by', 'css_scope', 'imported_from', 'styles_compiled'];

/** Names the API uses beside `/block-types/{id}`; a block type cannot take them. */
const ROUTE_NAMES = ['validate', 'preview', 'starters'];

export type WriteOutcome<T> =
  | { ok: true; status: 200; body: T }
  | { ok: false; status: number; body: { error: string; problems?: BlockTypeProblem[]; impact?: BlockTypeImpact; usage?: BlockTypeUsage } };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

let coreRegistry: Map<string, BlockType> | null = null;
function core(): Map<string, BlockType> {
  coreRegistry ??= buildCoreBlockRegistry();
  return coreRegistry;
}

/** True for block types shipped in code; they are read-only on every surface. */
export function isCoreBlockType(id: string): boolean {
  return core().has(id);
}

/** The definition without server-managed properties. */
export function writableInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (!SERVER_MANAGED.includes(key)) out[key] = value;
  return out;
}

const errorsOf = (problems: BlockTypeProblem[]) => problems.filter(problem => problem.severity === 'error');
const warningsOf = (problems: BlockTypeProblem[]) => problems.filter(problem => problem.severity === 'warning');

function invalid(problems: BlockTypeProblem[], fallback = 'The block type definition is invalid.'): WriteOutcome<never> {
  const errors = errorsOf(problems);
  const first = errors[0];
  const error = first
    ? `${first.path ? `${first.path}: ` : ''}${first.message}${errors.length > 1 ? ` (and ${errors.length - 1} more problem${errors.length > 2 ? 's' : ''})` : ''}`
    : fallback;
  return { ok: false, status: 400, body: { error, problems } };
}

/** A block type as the API returns it: with `styles_compiled`, the CSS that ships. */
export function blockTypeView<T extends BlockType>(type: T): T & { styles_compiled?: string } {
  if (!type.styles || type.css_scope !== 'block') return type;
  return { ...type, styles_compiled: scopeBlockCss(type.styles, type.name).css };
}

export async function siteBlockTypes(ctx: BlockTypeCtx): Promise<StoredBlockType[]> {
  return vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId);
}

// ─── Validate ─────────────────────────────────────────────────────────────

export interface DraftValidation {
  ok: boolean;
  problems: BlockTypeProblem[];
  merged: BlockType;
}

/**
 * Validate a definition without saving it. With `typeId` the input is a
 * patch to that stored type; otherwise it is a whole new definition.
 */
export async function validateBlockTypeDraft(
  ctx: BlockTypeCtx,
  input: unknown,
  options: { typeId?: string; allowScript: boolean },
): Promise<WriteOutcome<DraftValidation>> {
  if (!isRecord(input)) return invalid([{ severity: 'error', path: '', message: 'The block type must be a JSON object.' }]);
  const siteTypes = await siteBlockTypes(ctx);
  const resolveType = blockTypeResolver(siteTypes);
  let existing: StoredBlockType | undefined;
  if (options.typeId) {
    if (isCoreBlockType(options.typeId)) return { ok: false, status: 403, body: { error: 'Core block types are managed in code and cannot be changed.' } };
    existing = siteTypes.find(type => type.id === options.typeId);
    if (!existing) return { ok: false, status: 404, body: { error: `Block type "${options.typeId}" not found` } };
  }
  if (existing) {
    const { result, problems } = preparePatch(existing, input, siteTypes, options.allowScript);
    return { ok: true, status: 200, body: { ok: errorsOf(problems).length === 0, problems, merged: { ...result.merged, id: existing.id } } };
  }
  const { renames: _renames, confirm_data_loss: _confirm, ...definition } = writableInput(input);
  const result = validateBlockTypeDefinition(definition, { resolveType, allowScript: options.allowScript });
  const merged = { ...result.merged, id: result.merged.id || result.merged.name };
  if (merged.name && (siteTypes.some(type => type.id === merged.name) || isCoreBlockType(merged.name))) {
    result.problems.push({ severity: 'warning', path: '/name', message: `A block type named "${merged.name}" already exists; creating it again is refused.` });
  }
  return { ok: true, status: 200, body: { ok: errorsOf(result.problems).length === 0, problems: result.problems, merged } };
}

// ─── Create ───────────────────────────────────────────────────────────────

export interface CreateOptions {
  origin: BlockOrigin;
  allowScript: boolean;
}

export async function createSiteBlockType(
  ctx: BlockTypeCtx,
  input: unknown,
  options: CreateOptions,
): Promise<WriteOutcome<{ block_type: StoredBlockType; warnings: BlockTypeProblem[] }>> {
  if (!isRecord(input)) return invalid([{ severity: 'error', path: '', message: 'The block type must be a JSON object.' }]);
  const siteTypes = await siteBlockTypes(ctx);
  const result = validateBlockTypeDefinition(writableInput(input), { resolveType: blockTypeResolver(siteTypes), allowScript: options.allowScript });
  if (typeof result.value.name === 'string' && ROUTE_NAMES.includes(result.value.name)) {
    result.problems.push({ severity: 'error', path: '/name', message: `"${result.value.name}" is reserved by the block type API; choose another name.` });
  }
  if (errorsOf(result.problems).length) return invalid(result.problems);
  const name = result.value.name!;
  if (isCoreBlockType(name) || await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, name)) {
    return { ok: false, status: 409, body: { error: `Block type "${name}" already exists. Update it instead, or choose another name.` } };
  }
  const now = new Date().toISOString();
  const doc: StoredBlockType = {
    ...result.value,
    id: name,
    name,
    label: result.value.label ?? name,
    category: result.value.category ?? 'custom',
    container: result.value.container ?? false,
    schema: (result.value.schema ?? []) as FieldDefinition[],
    origin: options.origin,
    created_at: now,
    updated_at: now,
  };
  // Through the version chain: clears a tombstone a branch may hold for the name.
  await vstore.writeBlockType(ctx.orgId, ctx.siteId, ctx.versionId, name, doc);
  const stored = (await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, name)) ?? doc;
  return { ok: true, status: 200, body: { block_type: { ...stored, id: name }, warnings: warningsOf(result.problems) } };
}

// ─── Update ───────────────────────────────────────────────────────────────

export interface UpdateOptions {
  allowScript: boolean;
  actor: WriteActor;
  actorId: string;
}

function parseRenames(raw: unknown): { renames: Record<string, string>; problems: BlockTypeProblem[] } {
  if (raw === undefined) return { renames: {}, problems: [] };
  if (!isRecord(raw) || Object.values(raw).some(value => typeof value !== 'string')) {
    return { renames: {}, problems: [{ severity: 'error', path: '/renames', message: 'renames must map old field paths to new names, e.g. { "items.title": "heading" }.' }] };
  }
  return { renames: raw as Record<string, string>, problems: [] };
}

/**
 * Validate a patch with its `renames` and `confirm_data_loss`: plans the
 * schema change and, for a composed type whose props are renamed, rewrites
 * its own bindings unless the patch brings a new composition.
 */
function preparePatch(existing: BlockType, input: Record<string, unknown>, siteTypes: readonly BlockType[], allowScript: boolean) {
  const { renames: rawRenames, confirm_data_loss: confirm, ...rest } = writableInput(input);
  const definition: Record<string, unknown> = { ...rest };
  const { renames, problems: renameProblems } = parseRenames(rawRenames);
  if (confirm !== undefined && typeof confirm !== 'boolean') renameProblems.push({ severity: 'error', path: '/confirm_data_loss', message: 'confirm_data_loss must be true or false.' });
  if (Object.keys(renames).length && !Array.isArray(definition.schema)) {
    renameProblems.push({ severity: 'error', path: '/renames', message: 'Send the new schema together with renames.' });
  }
  let plan: SchemaChangePlan | undefined;
  if (Array.isArray(definition.schema) && definition.schema.every(isRecord)) {
    plan = planSchemaChange(existing.schema ?? [], definition.schema as unknown as FieldDefinition[], renames);
    renameProblems.push(...plan.problems);
    if (plan.renamed.length && existing.composition?.length && definition.composition === undefined) {
      definition.composition = renameCompositionBindings(existing.composition, plan);
    }
  }
  const result = validateBlockTypeDefinition(definition, { partial: true, existing, resolveType: blockTypeResolver(siteTypes), allowScript });
  return { result, plan, problems: [...renameProblems, ...result.problems], confirm: confirm === true };
}

/**
 * Update a site block type. Accepts `renames` and `confirm_data_loss` next to
 * the definition properties; a schema change reports its impact on every use
 * of the type, moves renamed data and refuses to drop data unconfirmed.
 */
export async function updateSiteBlockType(
  ctx: BlockTypeCtx,
  typeId: string,
  input: unknown,
  options: UpdateOptions,
): Promise<WriteOutcome<{ block_type: StoredBlockType; warnings: BlockTypeProblem[]; impact?: BlockTypeImpact }>> {
  if (isCoreBlockType(typeId)) return { ok: false, status: 403, body: { error: 'Core block types are managed in code and cannot be changed.' } };
  if (!isRecord(input)) return invalid([{ severity: 'error', path: '', message: 'The block type must be a JSON object.' }]);
  const siteTypes = await siteBlockTypes(ctx);
  const existing = siteTypes.find(type => type.id === typeId);
  if (!existing) return { ok: false, status: 404, body: { error: `Block type "${typeId}" not found` } };

  const { result, plan, problems, confirm } = preparePatch(existing, input, siteTypes, options.allowScript);
  if (errorsOf(problems).length) return invalid(problems);

  let impact: BlockTypeImpact | undefined;
  const changesData = !!plan && planChangesData(plan);
  if (plan) {
    impact = await applyBlockTypeChange(ctx, existing, plan, { apply: false, actor: options.actor, actorId: options.actorId });
    const losing = dataLossUsages(impact);
    if (losing.length && !confirm) {
      return {
        ok: false,
        status: 409,
        body: {
          error: `This change removes or retypes fields that hold data in ${losing.length} place(s). Send confirm_data_loss: true to drop that data, or rename the fields instead.`,
          impact: { ...impact, usages: losing },
        },
      };
    }
  }

  await vstore.writeBlockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId, { ...result.value, updated_at: new Date().toISOString() } as Partial<BlockType>);
  if (plan && changesData) impact = await applyBlockTypeChange(ctx, existing, plan, { apply: true, actor: options.actor, actorId: options.actorId });
  const stored = (await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId)) as StoredBlockType;
  return {
    ok: true,
    status: 200,
    body: { block_type: { ...stored, id: typeId }, warnings: warningsOf(problems), ...(impact ? { impact } : {}) },
  };
}

// ─── Delete ───────────────────────────────────────────────────────────────

export async function deleteSiteBlockType(ctx: BlockTypeCtx, typeId: string): Promise<WriteOutcome<{ ok: true }>> {
  if (isCoreBlockType(typeId)) return { ok: false, status: 403, body: { error: 'Core block types are managed in code and cannot be deleted.' } };
  const existing = await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (!existing) return { ok: false, status: 404, body: { error: `Block type "${typeId}" not found` } };
  // A caller who checks usage first and then deletes was, until 2026-09-22,
  // following a procedure that certified the destructive outcome: the usage
  // report could not return a match. The check belongs where the deletion
  // happens, on every surface.
  const usage = await getBlockTypeUsage(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (usageCount(usage) > 0) {
    return { ok: false, status: 409, body: { error: `Block type "${typeId}" is in use by ${describeBlockTypeUsage(usage)}. Remove those uses first.`, usage } };
  }
  await vstore.deleteBlockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  return { ok: true, status: 200, body: { ok: true } };
}

// ─── Preview ──────────────────────────────────────────────────────────────

export interface PreviewResult {
  ok: boolean;
  html: string;
  css: string;
  /** A standalone HTML document (site theme and CSS) for an iframe. */
  document: string;
  data: Record<string, unknown>;
  render_version?: number;
  problems: BlockTypeProblem[];
}

/**
 * Render an unsaved definition with sample or given data through the portal's
 * preview renderer. Body: `{ definition, data?, render_version?, type_id? }`;
 * with `type_id` the definition is a patch to that stored type (or omitted to
 * preview the stored type as is). Definitions with errors are not rendered.
 */
export async function previewBlockTypeDraft(
  ctx: BlockTypeCtx,
  body: unknown,
  options: { allowScript: boolean },
): Promise<WriteOutcome<PreviewResult>> {
  if (!isRecord(body)) return invalid([{ severity: 'error', path: '', message: 'Send { definition, data?, render_version? }.' }]);
  const typeId = typeof body.type_id === 'string' && body.type_id ? body.type_id : undefined;
  if (body.definition === undefined && !typeId) return invalid([{ severity: 'error', path: '/definition', message: 'definition is required.' }]);
  if (body.data !== undefined && !isRecord(body.data)) return invalid([{ severity: 'error', path: '/data', message: 'data must be an object of field values.' }]);
  if (body.render_version !== undefined && !(Number.isInteger(body.render_version) && (body.render_version as number) >= 1)) {
    return invalid([{ severity: 'error', path: '/render_version', message: 'render_version must be a render version number.' }]);
  }
  const validation = await validateBlockTypeDraft(ctx, body.definition ?? {}, { typeId, allowScript: options.allowScript });
  if (!validation.ok) return validation;
  const { problems, merged } = validation.body;
  const data = (body.data as Record<string, unknown> | undefined) ?? sampleBlockData(merged.schema);
  const empty: PreviewResult = { ok: false, html: '', css: '', document: '', data, problems };
  if (errorsOf(problems).length) return { ok: true, status: 200, body: empty };
  try {
    const { renderBlockTypePreview } = await import('./render-preview');
    const preview = await renderBlockTypePreview(ctx.orgId, ctx.siteId, ctx.versionId, {
      blockType: merged,
      data,
      renderVersion: body.render_version as number | undefined,
    });
    return { ok: true, status: 200, body: { ok: true, ...preview, data, problems } };
  } catch (error) {
    return { ok: true, status: 200, body: { ...empty, problems: [...problems, { severity: 'error', path: '', message: `The block could not be rendered: ${error instanceof Error ? error.message : String(error)}` }] } };
  }
}

// ─── Package import ───────────────────────────────────────────────────────

export type ImportConflictMode = 'skip' | 'rename' | 'replace';
export const IMPORT_CONFLICT_MODES: readonly ImportConflictMode[] = ['skip', 'rename', 'replace'];

export interface ImportedTypeOutcome {
  /** The name in the package. */
  name: string;
  action: 'created' | 'replaced' | 'renamed' | 'skipped' | 'failed';
  /** The id written, when written. */
  id?: string;
  problems?: BlockTypeProblem[];
}

export interface PackageImportResult {
  results: ImportedTypeOutcome[];
  created: number;
  /** Existing types replaced (on_conflict: replace). */
  updated: number;
  renamed: number;
  skipped: number;
  failed: number;
  block_type_ids: string[];
}

/** Point a definition's references to renamed package types at their new names. */
function renameReferences(type: BlockType, renamed: Map<string, string>): BlockType {
  if (!renamed.size) return type;
  const rename = (id: unknown) => (typeof id === 'string' && renamed.has(id) ? renamed.get(id)! : id);
  const visit = (block: import('@typeroll/shared').Block): import('@typeroll/shared').Block => ({
    ...block,
    type: rename(block.type) as string,
    data: block.data && 'item_block' in block.data ? { ...block.data, item_block: rename(block.data.item_block) } : block.data,
    ...(block.children ? { children: block.children.map(visit) } : {}),
    ...(block.slots ? { slots: block.slots.map(slot => slot.map(visit)) } : {}),
  });
  return {
    ...type,
    ...(type.composition ? { composition: type.composition.map(visit) } : {}),
    ...(type.expand_to ? { expand_to: {
      target: rename(type.expand_to.target) as string,
      defaults: 'item_block' in (type.expand_to.defaults ?? {}) ? { ...type.expand_to.defaults, item_block: rename(type.expand_to.defaults.item_block) } : type.expand_to.defaults,
    } } : {}),
  };
}

/**
 * Write the block types of an unpacked .tcblocks package. Each definition is
 * checked by the shared validator (against the site's types and the others in
 * the package); on a name conflict `onConflict` decides: `skip` (default)
 * keeps the site's type, `rename` imports under a free name (references in
 * the package follow), `replace` overwrites it.
 */
export async function importBlockTypePackage(
  ctx: BlockTypeCtx,
  blocks: ReadonlyArray<{ block_type: BlockType }>,
  options: { onConflict: ImportConflictMode; allowScript: boolean },
): Promise<PackageImportResult> {
  const siteTypes = await siteBlockTypes(ctx);
  const taken = new Set(siteTypes.map(type => type.id));
  const packageNames = new Set(blocks.map(({ block_type }) => block_type.name));
  const renamed = new Map<string, string>();
  const results: ImportedTypeOutcome[] = [];
  const pending: Array<{ outcome: ImportedTypeOutcome; type: BlockType; replace: boolean }> = [];
  for (const { block_type } of blocks) {
    const name = block_type.name;
    const conflict = taken.has(name) || isCoreBlockType(name);
    const outcome: ImportedTypeOutcome = { name, action: 'created' };
    results.push(outcome);
    if (conflict && options.onConflict === 'skip') { outcome.action = 'skipped'; continue; }
    if (conflict && (options.onConflict === 'rename' || isCoreBlockType(name))) {
      let index = 2;
      let next = `${name}_${index}`.slice(0, 64);
      while (taken.has(next) || packageNames.has(next) || isCoreBlockType(next)) next = `${name}_${++index}`.slice(0, 64);
      renamed.set(name, next);
      taken.add(next);
      outcome.action = 'renamed';
    } else if (conflict) {
      outcome.action = 'replaced';
    }
    pending.push({ outcome, type: block_type, replace: outcome.action === 'replaced' });
  }
  const definitions = pending.map(entry => {
    const name = renamed.get(entry.type.name) ?? entry.type.name;
    return { ...entry, type: { ...renameReferences(entry.type, renamed), id: name, name } };
  });
  const resolveType = blockTypeResolver([...siteTypes, ...definitions.map(entry => entry.type)]);
  const now = new Date().toISOString();
  for (const { outcome, type, replace } of definitions) {
    const input = Object.fromEntries(Object.entries(writableInput(type as unknown as Record<string, unknown>)).filter(([, value]) => value !== undefined));
    const result = validateBlockTypeDefinition(input, { resolveType, allowScript: options.allowScript });
    const problems = [...result.problems];
    if (ROUTE_NAMES.includes(type.name)) problems.push({ severity: 'error', path: '/name', message: `"${type.name}" is reserved by the block type API; rename the block type in the package.` });
    if (errorsOf(problems).length) {
      outcome.action = 'failed';
      outcome.problems = problems;
      continue;
    }
    const doc: StoredBlockType = {
      ...result.value,
      id: type.name,
      name: type.name,
      label: result.value.label ?? type.name,
      category: result.value.category ?? 'custom',
      container: result.value.container ?? false,
      schema: (result.value.schema ?? []) as FieldDefinition[],
      origin: 'third_party',
      ...(type.imported_from ? { imported_from: type.imported_from } : {}),
      created_at: now,
      updated_at: now,
    };
    if (doc.styles && type.css_scope !== 'block') {
      // Written before block scoping: the stylesheet stays global, as it was.
      delete doc.css_scope;
      problems.push({ severity: 'warning', path: '/styles', message: 'This stylesheet was written before block scoping and stays global. Update the block type to scope it.' });
    }
    if (replace) await vstore.deleteBlockType(ctx.orgId, ctx.siteId, ctx.versionId, type.name);
    await vstore.writeBlockType(ctx.orgId, ctx.siteId, ctx.versionId, type.name, doc);
    outcome.id = type.name;
    if (problems.length) outcome.problems = problems;
  }
  const count = (action: ImportedTypeOutcome['action']) => results.filter(outcome => outcome.action === action).length;
  return {
    results,
    created: count('created'),
    updated: count('replaced'),
    renamed: count('renamed'),
    skipped: count('skipped'),
    failed: count('failed'),
    block_type_ids: results.flatMap(outcome => (outcome.id ? [outcome.id] : [])),
  };
}

/** `on_conflict` from a query string or body; undefined when it is not a known mode. */
export function parseConflictMode(raw: unknown): ImportConflictMode | undefined {
  if (raw === undefined || raw === null || raw === '') return 'skip';
  return IMPORT_CONFLICT_MODES.includes(raw as ImportConflictMode) ? raw as ImportConflictMode : undefined;
}

/**
 * Block types an export includes by default: every type the site authored
 * or imported (user, ai and third-party), not those an Extension provisions.
 */
export function exportableBlockTypes(types: readonly BlockType[], ids: readonly string[] | null): BlockType[] {
  if (ids) return types.filter(type => ids.includes(type.id) && !type.extension);
  return types.filter(type => !type.extension && (type.origin ?? type.created_by) !== 'core');
}

// ─── Starters ─────────────────────────────────────────────────────────────

export function blockTypeStarters() {
  return { starters: BLOCK_TYPE_STARTERS };
}
