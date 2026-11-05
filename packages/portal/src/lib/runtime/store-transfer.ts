// Store transfer for self-hosted backup and restore
// (scripts/lib/self-host-cloudflare-backup.mjs has the client and contract).
// Durable Objects are reachable only from inside the portal Worker, so the
// backup reads objects page by page here and the restore drives the same
// bounded migration steps as the cutover import.
//
// Every request carries TYPEROLL_STORE_TRANSFER_TOKEN (at least 32
// characters). Without it, or with a wrong one, the route answers 404 like a
// missing route. The operator sets the token only for a backup or restore.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ReadWriteStore } from '../datastore';
import type { DocumentStoreRpc } from '../store/durable-object';
import { runMigrationStep, type MigrationAction, type MigrationRunDeps } from '../migration/worker-run';

export interface StoreTransferRuntime {
  store: ReadWriteStore;
  object(name: string): Pick<DocumentStoreRpc, 'paths' | 'getMany'> | { paths(after?: string, limit?: number): Promise<string[]>; getMany(paths: string[]): Promise<Array<{ data: Record<string, unknown> } | null>> };
  migration: Omit<MigrationRunDeps, 'enabled'> | null;
}

let runtime: (() => StoreTransferRuntime) | null = null;

/** The Worker registers how to reach store objects and the migration bucket. */
export function setStoreTransferRuntime(factory: (() => StoreTransferRuntime) | null): void {
  runtime = factory;
}

const OBJECT = /^(global|org:[^/\s]{1,128}|site:[0-9a-f-]{36})$/;
const MIGRATION_STEPS = new Set<MigrationAction>(['verify', 'import', 'compare', 'status']);

export class StoreTransferError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Constant-time token check; false whenever the token is unset or short. */
export function storeTransferAuthorized(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.TYPEROLL_STORE_TRANSFER_TOKEN?.trim() ?? '';
  const supplied = header?.match(/^Bearer (.+)$/)?.[1] ?? '';
  if (expected.length < 32 || !supplied) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export async function handleStoreTransfer(body: Record<string, unknown>): Promise<unknown> {
  if (!runtime) throw new StoreTransferError('Store transfer needs the Durable Object store', 503);
  const rt = runtime();
  switch (body.action) {
    case 'objects': {
      const organizations = await rt.store.listDocs('organizations');
      const owners = await rt.store.listDocs<{ uid?: string }>('site_owners');
      return { objects: [
        { name: 'global', kind: 'global' },
        ...organizations.map(org => ({ name: `org:${org.id}`, kind: 'org' })),
        ...owners.filter(owner => typeof owner.uid === 'string').map(owner => ({ name: `site:${owner.uid}`, kind: 'site' })),
      ] };
    }
    case 'paths': {
      const object = objectName(body.object);
      const after = typeof body.after === 'string' ? body.after : '';
      const limit = Math.max(1, Math.min(5000, Number(body.limit) || 1000));
      const paths = await rt.object(object).paths(after, limit);
      return { paths, next: paths.length === limit ? paths.at(-1)! : null };
    }
    case 'get_many': {
      const object = objectName(body.object);
      if (!Array.isArray(body.paths) || body.paths.length > 500 || !body.paths.every(path => typeof path === 'string')) throw new StoreTransferError('paths must be up to 500 strings');
      const documents = await rt.object(object).getMany(body.paths as string[]);
      return { documents: documents.map(doc => doc ? { data: doc.data } : null) };
    }
    case 'migration': {
      if (!rt.migration) throw new StoreTransferError('The MIGRATION bucket is not bound', 503);
      if (!MIGRATION_STEPS.has(body.step as MigrationAction)) throw new StoreTransferError('Unknown migration step');
      // The token is the window: holding it enables the steps for this route.
      return runMigrationStep({ ...rt.migration, enabled: true }, { run: String(body.run ?? ''), action: body.step as MigrationAction, force: body.force === true });
    }
    default:
      throw new StoreTransferError('Unknown action');
  }
}

function objectName(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT.test(value)) throw new StoreTransferError('Invalid object name');
  return value;
}
