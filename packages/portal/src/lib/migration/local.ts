// Local SQLite stand-ins for the Durable Objects, for rehearsals and tests.
//
// `local:<dir>` keeps one SQLite file per object (`global.sqlite`,
// `org-<id>.sqlite`, `site-<uid>.sqlite`), the same split as production, so an
// import, compare or export against it exercises the real sharding.
// `sqlite:<file>` is one unsharded store (`TYPEROLL_STORE=sqlite:<file>`).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nodeSqliteDriver } from '../store/node-sqlite';
import { SqlDocumentEngine, type SqlDriver } from '../store/sql-engine';
import { localTransport, type StoreTransport } from '../store/sql-store';
import { ShardedStore } from '../store/sharded-store';
import type { SqlExportObject } from './export';
import type { MigrationTarget } from './import';

const fileFor = (name: string) => name === 'global' ? 'global.sqlite'
  : name.startsWith('org:') ? `org-${encodeURIComponent(name.slice(4))}.sqlite`
  : name.startsWith('site:') ? `site-${encodeURIComponent(name.slice(5))}.sqlite`
  : (() => { throw new Error(`Unknown object ${name}`); })();

const nameFor = (file: string) => !file.endsWith('.sqlite') ? null : file === 'global.sqlite' ? 'global'
  : file.startsWith('org-') ? `org:${decodeURIComponent(file.slice(4, -7))}`
  : file.startsWith('site-') ? `site:${decodeURIComponent(file.slice(5, -7))}` : null;

/** A SQL document database as an export object. */
export function sqlObject(name: string, kind: SqlExportObject['kind'], driver: SqlDriver): SqlExportObject {
  const engine = new SqlDocumentEngine(driver);
  return {
    name, kind,
    async *paths() {
      let after = '';
      for (;;) {
        const rows = driver.exec<{ path: string }>('SELECT path FROM documents WHERE path > ? ORDER BY path LIMIT 1000', after);
        for (const row of rows) yield row.path;
        if (rows.length < 1000) return;
        after = rows.at(-1)!.path;
      }
    },
    getMany: async paths => engine.getMany(paths),
  };
}

export interface LocalShardedTarget extends MigrationTarget {
  /** Every object file in the directory, for an export of the whole target. */
  objects(): SqlExportObject[];
}

export function localShardedTarget(dir: string, newId: () => string = randomUUID): LocalShardedTarget {
  fs.mkdirSync(dir, { recursive: true });
  const drivers = new Map<string, SqlDriver>(), transports = new Map<string, StoreTransport>();
  const driver = (name: string) => {
    let found = drivers.get(name);
    if (!found) drivers.set(name, found = nodeSqliteDriver(path.join(dir, fileFor(name))));
    return found;
  };
  const transport = (name: string) => {
    let found = transports.get(name);
    if (!found) transports.set(name, found = localTransport(new SqlDocumentEngine(driver(name))));
    return found;
  };
  const store = new ShardedStore({ transport }, newId);
  return {
    store, transport,
    objects: () => fs.readdirSync(dir).sort().flatMap(file => {
      const name = nameFor(file);
      if (!name) return [];
      const kind = name === 'global' ? 'global' : name.startsWith('org:') ? 'org' : 'site';
      return [sqlObject(name, kind, driver(name))];
    }),
  };
}

/** One unsharded SQLite store file as an export source object. */
export function sqliteFileObject(file: string): SqlExportObject {
  if (!fs.existsSync(file)) throw new Error(`No such store file: ${file}`);
  return sqlObject(path.basename(file), 'single', nodeSqliteDriver(file));
}
