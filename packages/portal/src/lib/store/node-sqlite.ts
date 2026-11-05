// node:sqlite driver for the SQL document engine (local development and tests).
import type { SqlDriver } from './sql-engine';

export function nodeSqliteDriver(file = ':memory:'): SqlDriver {
  // Loaded on demand so importing the store never pulls in node:sqlite.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  let depth = 0;
  return {
    exec<T>(sql: string, ...params: unknown[]): T[] {
      const statement = db.prepare(sql);
      const reads = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
      return (reads ? statement.all(...params as never[]) : (statement.run(...params as never[]), [])) as T[];
    },
    transaction<T>(work: () => T): T {
      // Nested calls join the outer transaction, as Durable Object transactionSync does.
      if (depth > 0) return work();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    },
  };
}
