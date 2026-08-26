// Build-time datastore. Reads content for the current site so Astro can SSG.
//
// Two backends:
//   - firestore: production. Uses firebase-admin with a service-account JSON
//                from FIREBASE_SERVICE_ACCOUNT env var.
//   - fixtures:  local dev / open-source. Reads JSON files from a directory
//                tree on disk. Selected automatically when no service account
//                is configured.
//
// One narrow interface so the renderer doesn't care which backend it has.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReadStore {
  getDoc<T = unknown>(p: string): Promise<T | null>;
  listDocs<T = unknown>(collectionPath: string): Promise<Array<T & { id: string }>>;
}

// ─── Fixtures backend ────────────────────────────────────────────────────

class FixtureStore implements ReadStore {
  constructor(private root: string) {}

  private resolve(p: string): { docPath: string; dirPath: string } {
    const dirPath = path.resolve(this.root, p);
    const rootResolved = path.resolve(this.root);
    if (dirPath !== rootResolved && !dirPath.startsWith(rootResolved + path.sep)) {
      throw new Error(`Refusing to access path outside fixtures root: ${p}`);
    }
    const docPath = `${dirPath}.json`;
    return { docPath, dirPath };
  }

  async getDoc<T>(p: string): Promise<T | null> {
    const { docPath } = this.resolve(p);
    if (!fs.existsSync(docPath)) return null;
    const raw = await fs.promises.readFile(docPath, 'utf-8');
    return JSON.parse(raw) as T;
  }

  async listDocs<T>(p: string): Promise<Array<T & { id: string }>> {
    const { dirPath } = this.resolve(p);
    if (!fs.existsSync(dirPath)) return [];
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const results: Array<T & { id: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.replace(/\.json$/, '');
      const raw = await fs.promises.readFile(path.join(dirPath, entry.name), 'utf-8');
      results.push({ id, ...(JSON.parse(raw) as T) });
    }
    return results;
  }
}

// ─── Firestore backend ───────────────────────────────────────────────────

class FirestoreStore implements ReadStore {
  private dbPromise: Promise<import('firebase-admin/firestore').Firestore>;

  constructor(serviceAccountJson: string) {
    this.dbPromise = (async () => {
      const { initializeApp, cert, getApps } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      const credentials = JSON.parse(serviceAccountJson);
      const app =
        getApps()[0] ??
        initializeApp({ credential: cert(credentials), projectId: credentials.project_id });
      return getFirestore(app);
    })();
  }

  async getDoc<T>(p: string): Promise<T | null> {
    const db = await this.dbPromise;
    const snap = await db.doc(p).get();
    return snap.exists ? ((snap.data() as T) ?? null) : null;
  }

  async listDocs<T>(p: string): Promise<Array<T & { id: string }>> {
    const db = await this.dbPromise;
    const snap = await db.collection(p).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

function defaultFixturesDir(): string {
  // Default to packages/site-template/fixtures when running locally.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'fixtures');
}

let cached: ReadStore | null = null;

export function getStore(): ReadStore {
  if (cached) return cached;
  // An explicit fixtures dir always wins — even when a Firestore service
  // account is also present in the environment.
  //
  // A deploy build materialises a self-contained, *chain-resolved* fixtures
  // snapshot (settings, block types, collections, … with branch inheritance
  // already applied by the portal's version-store) and points us at it via
  // TYPEROLL_FIXTURES_DIR. That snapshot — not live Firestore — is the source
  // of truth for the build. The deploy worker runs on Cloud Run with
  // FIREBASE_SERVICE_ACCOUNT set, which leaks into the build's env; if we let
  // that select FirestoreStore we'd bypass the snapshot and read version docs
  // raw, with no chain-fallback. For a branch that never overrode settings the
  // doc simply doesn't exist, so the read returns null and the site renders
  // with defaultSiteSettings (lang=en, Inter, "New Site", no favicon). Hence:
  // if someone handed us a fixtures dir, use it.
  const explicitFixtures = process.env.TYPEROLL_FIXTURES_DIR;
  if (explicitFixtures) {
    cached = new FixtureStore(explicitFixtures);
    return cached;
  }
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa && sa.trim().startsWith('{')) {
    cached = new FirestoreStore(sa);
  } else {
    cached = new FixtureStore(defaultFixturesDir());
  }
  return cached;
}
