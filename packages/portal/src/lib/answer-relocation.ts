// A reviewed, one-time move of accepted answers to other paths of the same
// Page, keeping who gave each answer.
//
// A normal write stamps the writer as the answer's source, and an import is
// the weakest writer. Neither can move an owner's answer from, say, a company
// group to one of its programs without either losing the owner's protection
// or reattributing it to the API. This moves the value and its provenance
// together: the original source, actor, time, evidence and any protection an
// ancestor gave it, with a note of where it came from.
//
// It moves only what it is told, only where nothing protected is in the way:
// a target with its own attribution (also an explicit clear or an emptied
// group) or a different value is reported and left alone, and a target that
// already has the same value keeps its own attribution. The source stays in
// place; retiring source fields is a separate, deliberate schema change.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { contentPagePath, type FieldDefinition, type Page } from '@typeroll/shared';
import { getStore } from './datastore';
import { readProvenance, type ProvenanceEntry, type ProvenanceMap } from './field-authority';
import { proposalCollection, type OwnerProposal } from './owner-proposals';
import { PageImportError, revisionFor, segments, snapshot } from './page-import';
import { validatePageFields } from './page-fields';
import { markSiteDirty } from './auto-deploy';

type Scope = { orgId: string; siteId: string; versionId: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const empty = (value: unknown) => value === undefined || value === null;

export type RelocationOutcome =
  /** Moved, with the source's attribution. */
  | 'relocated'
  /** The target already holds the same value; value and attribution left as they are. */
  | 'already_present'
  /** The target has its own attribution (an answer, an explicit clear or an emptied group). */
  | 'protected_target'
  /** The target holds a different, unattributed value. */
  | 'conflicting_target'
  /** Nothing to move: no value and no attribution at the source. */
  | 'missing_source';

interface Node { container: Record<string, unknown>; name: string; field: FieldDefinition }

/**
 * Resolve a leaf or an object group (not a list) by schema path. Keyed list
 * items are addressed as `@<stable id>` and must exist: a move never creates
 * a program or changes an item identity.
 */
function node(fields: FieldDefinition[], values: Record<string, unknown>, path: string, create: boolean): Node {
  const parts = segments(path);
  let schema = fields, container = values;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const field = schema.find(item => item.name === name);
    if (!field) throw new PageImportError(`Unknown field path: ${path}`);
    if (i === parts.length - 1) {
      if (field.fields && ['array', 'list'].includes(field.type)) throw new PageImportError(`Move a leaf or a group, not a whole list: ${path}`);
      return { container, name, field };
    }
    if (field.type === 'object' && field.fields) {
      if (container[name] == null) {
        if (create) container[name] = {};
        else { container = {}; schema = field.fields; continue; }
      }
      if (!object(container[name])) throw new PageImportError(`Expected an object at ${name}`);
      container = container[name] as Record<string, unknown>; schema = field.fields;
    } else if (field.fields && field.item_key && ['array', 'list'].includes(field.type)) {
      const selector = parts[++i];
      if (!selector?.startsWith('@') || selector.length === 1 || i === parts.length - 1)
        throw new PageImportError(`Use @<stable item id> followed by a field: ${path}`);
      const rows = container[name];
      const matches = Array.isArray(rows) ? rows.filter(row => object(row) && row[field.item_key!] === selector.slice(1)) : [];
      if (matches.length !== 1) throw new PageImportError(`Expected one existing keyed item: ${path}`);
      if (parts[i + 1] === field.item_key) throw new PageImportError('A move cannot change a stable item identity');
      container = matches[0] as Record<string, unknown>; schema = field.fields;
    } else throw new PageImportError(`Not a structured field: ${path}`);
  }
  throw new PageImportError('Expected a field path');
}

const canonicalPath = (path: string) => segments(path).map(escape).join('/');
const within = (key: string, path: string) => key === path || key.startsWith(`${path}/`);
const ancestorEntry = (provenance: ProvenanceMap, path: string): [string, ProvenanceEntry] | undefined => {
  for (let key = path; key; key = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '') if (provenance[key]) return [key, provenance[key]];
  return undefined;
};

function protectedTarget(provenance: ProvenanceMap, path: string): boolean {
  if (Object.keys(provenance).some(key => within(key, path))) return true;
  const parts = path.split('/');
  for (let end = parts.length - 1; end > 0; end--) {
    const ancestor = parts.slice(0, end).join('/');
    const item = parts[end - 1]!.startsWith('@'), list = parts[end]!.startsWith('@');
    if (!item && !list && provenance[ancestor]) return true;
  }
  return false;
}

/** Pending owner proposals that change any of these top-level fields of the Page. */
async function pendingProposalFields(scope: Scope, pageId: string, roots: Set<string>): Promise<string[]> {
  const proposals = await getStore().listDocs<OwnerProposal>(proposalCollection(scope), { filters: [{ field: 'page_id', op: '==', value: pageId }] });
  const touched = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.status !== 'pending' || (proposal.version_id ?? scope.versionId) !== scope.versionId) continue;
    for (const name of Object.keys(proposal.changes ?? {})) if (roots.has(name)) touched.add(name);
  }
  return [...touched];
}

export interface RelocationInput { base_revision: string; dry_run?: boolean; reason: string; moves: Array<{ from: string; to: string }> }

export async function relocatePageAnswers(scope: Scope, pageId: string, input: unknown, actorId: string) {
  if (!object(input) || Object.keys(input).some(key => !['base_revision', 'dry_run', 'reason', 'moves'].includes(key)))
    throw new PageImportError('Expected base_revision, reason, moves and optional dry_run');
  if (typeof input.base_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.base_revision)) throw new PageImportError('A current authority base_revision is required');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw new PageImportError('reason must say why, in up to 500 characters');
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') throw new PageImportError('dry_run must be true or false');
  if (!Array.isArray(input.moves) || !input.moves.length || input.moves.length > 200) throw new PageImportError('moves must contain 1–200 moves');

  const state = await snapshot(scope, pageId);
  if (state.revision !== input.base_revision) throw new PageImportError('Page, schema or draft changed. Read authority again before relocating.', 409);
  const page = state.saved.page!;
  const moves = input.moves.map((move: unknown) => {
    if (!object(move) || Object.keys(move).some(key => !['from', 'to'].includes(key)) || typeof move.from !== 'string' || typeof move.to !== 'string')
      throw new PageImportError('Each move must contain only from and to');
    const from = canonicalPath(move.from), to = canonicalPath(move.to);
    if (within(to, from) || within(from, to)) throw new PageImportError(`A move cannot overlap itself: ${from} → ${to}`);
    return { from, to };
  });
  const targets = new Set<string>();
  for (const { to } of moves) {
    if ([...targets].some(other => within(other, to) || within(to, other))) throw new PageImportError(`Two moves write the same target: ${to}`);
    targets.add(to);
  }

  // Unsaved drafts and pending owner reviews would be decided against values
  // this moves; they are resolved first.
  const roots = new Set(moves.flatMap(({ from, to }) => [segments(from)[0]!, segments(to)[0]!]));
  const draft = state.working as { fields?: Record<string, unknown> } | null;
  const drafted = draft ? Object.keys(draft.fields ?? {}).filter(name => roots.has(name)) : [];
  if (drafted.length) throw new PageImportError(`Save or discard the working copy first; it changes ${drafted.join(', ')}.`, 409);
  const reviewed = await pendingProposalFields(scope, pageId, roots);
  if (reviewed.length) throw new PageImportError(`Decide the pending owner review first; it changes ${reviewed.join(', ')}.`, 409);

  const provenance = readProvenance(page);
  const nextFields = structuredClone(page.fields ?? {});
  const nextProvenance: ProvenanceMap = { ...provenance };
  const now = new Date().toISOString();
  const receipt: Array<{ from: string; to: string; outcome: RelocationOutcome; attribution: 'explicit' | 'inherited' | 'unattributed'; source: ProvenanceEntry['source'] | null }> = [];

  for (const { from, to } of moves) {
    const source = node(state.type.fields, structuredClone(page.fields ?? {}), from, false);
    const value = source.container[source.name];
    // The source's own entries and its descendants', else the ancestor that protects it.
    const own = Object.entries(provenance).filter(([key]) => within(key, from));
    const inherited = own.some(([key]) => key === from) ? undefined : ancestorEntry(provenance, from);
    const entries: Array<[string, ProvenanceEntry]> = inherited ? [[from, inherited[1]], ...own] : own;
    const top = entries.find(([key]) => key === from)?.[1] ?? null;
    const attribution = own.some(([key]) => key === from) ? 'explicit' : inherited ? 'inherited' : 'unattributed';
    const report = (outcome: RelocationOutcome) => receipt.push({ from, to, outcome, attribution, source: top?.source ?? null });
    if (empty(value) && !entries.length) { report('missing_source'); continue; }

    const target = node(state.type.fields, nextFields, to, true);
    const current = target.container[target.name];
    const blank = (item: unknown) => empty(item) || (object(item) && !Object.keys(item).length);
    // A target that already holds the same answer keeps its value and its own attribution.
    if (!blank(current) && isDeepStrictEqual(current, value)) { report('already_present'); continue; }
    // A target answered, cleared or emptied on its own record is never replaced:
    // its own entry, a descendant's, or an enclosing group's. A list and its
    // items are stamped whenever any item is saved, so those do not count.
    if (protectedTarget(nextProvenance, to)) { report('protected_target'); continue; }
    if (!blank(current)) { report('conflicting_target'); continue; }

    target.container[target.name] = structuredClone(value ?? null);
    for (const [key, entry] of entries) {
      const destination = to + key.slice(from.length);
      nextProvenance[destination] = { ...entry, relocated_from: inherited && key === from ? inherited[0] : key, relocated_at: now };
    }
    const invalid = validatePageFields({ ...state.type, fields: [target.field] }, { [target.name]: target.container[target.name] });
    if (invalid) throw new PageImportError(`${to}: ${invalid}`);
    report('relocated');
  }

  const next: Page = { ...page, fields: nextFields, _provenance: nextProvenance };
  if (contentPagePath(page, state.type) !== contentPagePath(next, state.type))
    throw new PageImportError('Relocation would change the Page URL.', 409);
  const changed = !isDeepStrictEqual(page.fields ?? {}, nextFields) || !isDeepStrictEqual(provenance, nextProvenance);
  const summary = Object.fromEntries((['relocated', 'already_present', 'protected_target', 'conflicting_target', 'missing_source'] as const)
    .map(outcome => [outcome, receipt.filter(item => item.outcome === outcome).length]));
  // Paths, outcomes and kinds of source only: no values, actors or evidence.
  const result = { page_id: pageId, dry_run: input.dry_run === true, changed, base_revision: state.revision, summary, moves: receipt };
  if (input.dry_run === true || !changed) return { ...result, revision: state.revision };

  next.date_updated = now;
  const effects = [...state.saved.guards.filter(guard => guard.path !== state.saved.destination), ...state.schema.guards,
    { path: state.workingPath, expected: state.working, data: state.working ?? {}, guardOnly: true },
    { path: `${state.saved.destination}/answer_history/${randomUUID()}`, expected: null, replace: true, data: {
      actor: 'relocation', actor_id: actorId, at: now, reason: input.reason.trim(), moves: receipt,
      before: page.fields ?? {}, after: nextFields, provenance: nextProvenance,
    } }];
  if (!await getStore().compareAndReplaceDoc(state.saved.destination, state.saved.physical, next, effects))
    throw new PageImportError('Page, schema or draft changed while relocating. Read authority again.', 409);
  // Pending owner reviews are checked again after the write is guarded, so
  // one submitted in between is not decided against moved values unnoticed.
  const raced = await pendingProposalFields(scope, pageId, roots);
  await markSiteDirty(scope.orgId, scope.siteId, scope.versionId);
  return { ...result, revision: revisionFor(scope, next, state.type, state.working), ...(raced.length ? { warning: `An owner review of ${raced.join(', ')} was submitted during the relocation; review it against the moved answers.` } : {}) };
}
