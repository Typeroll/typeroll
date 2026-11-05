// Operator administration of portal accounts (Better Auth rows `auth_user`).
//
// Rows are changed under compare-and-replace, never through a blind write.
// Disabling sets `disabled` and `credentialsValidAfter`, then deletes every
// session of the account: portal sessions end at once (no cookie cache) and
// account-standing.ts refuses MCP/OAuth credentials granted before that
// moment. Email addresses are never changed here, so unique-value indexes are
// untouched; a deleted session leaves only a stale token index, which the
// store adapter treats as free.

import type { ReadWriteStore } from '../datastore';
import { PORTAL_AUTH_PREFIX } from '../identity/portal-auth';
import { OperatorApiError, type PeoplePage, type PersonRecord, type PersonUpdate, type PersonUpdateResult } from './contract';
import { body } from './documents';

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const USERS = `${PORTAL_AUTH_PREFIX}_user`;
const SESSIONS = `${PORTAL_AUTH_PREFIX}_session`;
const ATTEMPTS = 8;
const PAGE = 100;

type Row = Record<string, unknown> & { id: string };

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function same(a: PersonRecord, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  const other = b as Record<string, unknown>;
  return (Object.keys(a) as Array<keyof PersonRecord>).every(key => a[key] === other[key]);
}

export class OperatorPeople {
  constructor(private readonly store: () => ReadWriteStore, private readonly now: () => Date) {}

  private async sessions(userId: string): Promise<Row[]> {
    return this.store().listDocs<Row>(SESSIONS, { filters: [{ field: 'userId', op: '==', value: userId }] });
  }

  private async record(row: Row): Promise<PersonRecord> {
    const starts = (await this.sessions(row.id)).map(session => iso(session.createdAt)).filter((value): value is string => !!value).sort();
    return {
      id: row.id,
      email: typeof row.email === 'string' ? row.email : '',
      name: typeof row.name === 'string' ? row.name : '',
      emailVerified: row.emailVerified === true,
      disabled: row.disabled === true,
      createdAt: iso(row.createdAt),
      lastSessionAt: starts.at(-1) ?? null,
      credentialsValidAfter: iso(row.credentialsValidAfter),
    };
  }

  async listPeople(options: { cursor?: string; limit?: number } = {}): Promise<PeoplePage> {
    const limit = options.limit ?? PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE) throw new OperatorApiError('invalid_request', `limit must be 1–${PAGE}`);
    if (options.cursor !== undefined && !USER_ID.test(options.cursor)) throw new OperatorApiError('invalid_request', 'invalid page cursor');
    const rows = await this.store().listDocs<Row>(USERS, { limit, startAfterId: options.cursor ?? '' });
    const people = await Promise.all(rows.map(row => this.record(row)));
    return { people, next: rows.length === limit ? rows.at(-1)!.id : null };
  }

  async getPerson(id: string): Promise<PersonRecord | null> {
    if (!USER_ID.test(id)) throw new OperatorApiError('invalid_request', 'invalid person id');
    const row = await this.store().getDoc<Row>(`${USERS}/${id}`);
    return row ? this.record(row) : null;
  }

  async updatePerson(update: PersonUpdate): Promise<PersonUpdateResult> {
    if (typeof update !== 'object' || update === null || !USER_ID.test(update.id)) throw new OperatorApiError('invalid_request', 'invalid person id');
    const name = update.name;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\x00-\x1f]/.test(name))) {
      throw new OperatorApiError('invalid_request', 'a name has 1–120 characters');
    }
    if (update.disabled !== undefined && typeof update.disabled !== 'boolean') throw new OperatorApiError('invalid_request', 'disabled must be a boolean');
    const path = `${USERS}/${update.id}`;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = await this.store().getDoc<Row>(path);
      if (!row) return { ok: false, reason: 'not_found' };
      if (!same(await this.record(row), update.expected)) return { ok: false, reason: 'conflict' };
      const now = this.now().toISOString();
      const next: Record<string, unknown> = { ...body(row), updatedAt: now };
      if (name !== undefined) next.name = name.trim();
      if (update.disabled !== undefined) next.disabled = update.disabled;
      if (update.disabled === true) next.credentialsValidAfter = now;
      if (!await this.store().compareAndReplaceDoc(path, row, next)) continue;
      if (update.disabled === true) await this.endSessions(update.id);
      return { ok: true, person: (await this.getPerson(update.id))! };
    }
    throw new OperatorApiError('conflict', 'the account is changing too often; retry');
  }

  /** Refuse every delegated credential (MCP/OAuth, owner-approved keys) granted until now. */
  async revokePersonCredentials(id: string): Promise<PersonRecord | null> {
    if (!USER_ID.test(id)) throw new OperatorApiError('invalid_request', 'invalid person id');
    const path = `${USERS}/${id}`;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = await this.store().getDoc<Row>(path);
      if (!row) return null;
      const now = this.now().toISOString();
      if (await this.store().compareAndReplaceDoc(path, row, { ...body(row), credentialsValidAfter: now, updatedAt: now })) return this.getPerson(id);
    }
    throw new OperatorApiError('conflict', 'the account is changing too often; retry');
  }

  private async endSessions(userId: string): Promise<void> {
    const store = this.store();
    for (const session of await this.sessions(userId)) await store.deleteDoc(`${SESSIONS}/${session.id}`);
  }
}
