import type { MigrationStatus, MigrationStepRequest } from '../migration/worker-run';
// The narrow internal API that the private Typeroll Cloud operator uses on
// Cloudflare instead of writing Core data directly.
//
// Transport: Workers RPC over a Service Binding. The portal Worker exports a
// named entrypoint `OperatorApi` (a `WorkerEntrypoint` whose methods delegate
// to `createOperatorApi()`), and only the operator Worker is given a binding
// to it (`CORE_API`). There is no HTTP route, so nothing on the internet can
// reach it; the binding itself is the credential. Never bind it to another
// Worker, and never expose its methods through a route.
//
// Every value crossing the binding is plain JSON-compatible data. Refusals
// throw an `OperatorApiError` whose message starts with `operator_api/<code>:`
// so the code survives RPC error serialization. Expected outcomes (a commit
// whose condition no longer holds, a person that changed) are return values.

/** Bumped on any incompatible change; the operator declares the range it supports. */
export const OPERATOR_API_VERSION = 1;

export type DocumentData = Record<string, unknown>;
export type ApiDocument = DocumentData & { id: string };

export interface ListOptions {
  /** Equality filters only. */
  filters?: Array<{ field: string; value: string | number | boolean | null }>;
  /** Page size, at most MAX_PAGE (default MAX_PAGE). */
  limit?: number;
  /** Pages are ordered by document id; pass the previous page's `next`. */
  startAfterId?: string;
}

export interface DocumentPage { documents: ApiDocument[]; next: string | null }

/**
 * A conditional commit, like a Firestore transaction reduced to its read and
 * write sets: the writes apply only when every read still has the value the
 * caller saw (`null` = absent).
 *
 * - Every read must lie in one atomic scope: one site (its document and
 *   everything below it), one organization (its document and everything below
 *   it except its sites), or the global root collections.
 * - Writes replace whole documents (`data`) or delete them (`null`). A write
 *   outside the reads' scope is unconditional and is delivered with the commit.
 * - Deletions are applied right after the conditional commit. A deleted
 *   document that was also read is marked `_operator_deleting: true` inside
 *   the commit, so two commits cannot both delete it; if the caller dies
 *   before the deletion, the marked document remains and a retry removes it.
 */
export interface CommitRequest {
  reads: Array<{ path: string; value: ApiDocument | null }>;
  writes: Array<{ path: string; data: DocumentData | null }>;
}

export interface CommitResult { ok: boolean }

/** A portal account as the operator sees it. Dates are ISO strings or null. */
export interface PersonRecord {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string | null;
  /** Start of the newest live portal session; null when none exists. */
  lastSessionAt: string | null;
  /** Delegated credentials granted before this moment are refused. */
  credentialsValidAfter: string | null;
}

export interface PeoplePage { people: PersonRecord[]; next: string | null }

export interface PersonUpdate {
  id: string;
  /** The record the operator reviewed; the update is refused when it changed. */
  expected: PersonRecord;
  name?: string;
  disabled?: boolean;
}

export type PersonUpdateResult =
  | { ok: true; person: PersonRecord }
  | { ok: false; reason: 'not_found' | 'conflict' };

/** One E2E persona: a portal account with a password. */
export interface PersonaAccount { persona: string; uid: string; email: string; password: string; name: string }

export interface PersonaSeedRequest {
  personas: PersonaAccount[];
  /** Fixture documents; `preserve` names top-level fields kept from the existing document. */
  documents: Array<{ path: string; data: DocumentData; preserve?: string[] }>;
}

export interface PersonaInspectRequest {
  personas: Array<Pick<PersonaAccount, 'persona' | 'uid' | 'email' | 'password'>>;
  paths: string[];
}

export interface PersonaState {
  persona: string;
  uid: string;
  exists: boolean;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  testAccount: boolean;
  passwordValid: boolean;
}

export interface PersonaInspection { personas: PersonaState[]; documents: Record<string, ApiDocument | null> }

export interface OperatorApiDescription { api: 'typeroll-operator'; version: number; data_schema_version: number }

/** The methods of the `OperatorApi` entrypoint. */
export interface OperatorApiMethods {
  describe(): Promise<OperatorApiDescription>;
  getDocument(path: string): Promise<ApiDocument | null>;
  getDocuments(paths: string[]): Promise<Array<ApiDocument | null>>;
  listDocuments(collection: string, options?: ListOptions): Promise<DocumentPage>;
  commit(request: CommitRequest): Promise<CommitResult>;
  listPeople(options?: { cursor?: string; limit?: number }): Promise<PeoplePage>;
  getPerson(id: string): Promise<PersonRecord | null>;
  updatePerson(update: PersonUpdate): Promise<PersonUpdateResult>;
  revokePersonCredentials(id: string): Promise<PersonRecord | null>;
  seedE2EPersonas(request: PersonaSeedRequest): Promise<PersonaInspection>;
  inspectE2EPersonas(request: PersonaInspectRequest): Promise<PersonaInspection>;
  /** One bounded step of the cutover data import (runbook steps 5–6). */
  runMigrationStep(request: MigrationStepRequest): Promise<MigrationStatus>;
}

export const OPERATOR_API_METHOD_NAMES = [
  'describe', 'getDocument', 'getDocuments', 'listDocuments', 'commit',
  'listPeople', 'getPerson', 'updatePerson', 'revokePersonCredentials',
  'seedE2EPersonas', 'inspectE2EPersonas', 'runMigrationStep',
] as const satisfies ReadonlyArray<keyof OperatorApiMethods>;

export const MAX_PAGE = 500;
export const MAX_BATCH = 100;
export const MAX_COMMIT_DOCUMENTS = 100;

export type OperatorApiErrorCode =
  | 'invalid_request' | 'forbidden_path' | 'cross_scope_condition' | 'not_enabled' | 'not_found' | 'conflict';

export class OperatorApiError extends Error {
  constructor(readonly code: OperatorApiErrorCode, detail: string) {
    super(`operator_api/${code}: ${detail}`);
    this.name = 'OperatorApiError';
  }
}
