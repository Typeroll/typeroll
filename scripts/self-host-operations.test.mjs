import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createSelfHostBackup,
  decodeBackupKey,
  restoreSelfHostBackup,
  verifySelfHostBackup,
} from './lib/self-host-backup.mjs';
import {
  applySelfHostMigrations,
  bootstrapSelfHost,
  migrationStatus,
} from './lib/self-host-operations.mjs';
import {
  SELF_HOST_CORE_VERSION,
  SELF_HOST_DATA_SCHEMA_READABLE_MAX,
  SELF_HOST_DATA_SCHEMA_READABLE_MIN,
  SELF_HOST_DATA_SCHEMA_VERSION,
  SELF_HOST_INSTALLATION_PATH,
  planSelfHostMigrations,
} from './lib/self-host-schema.mjs';

const BACKUP_KEY = decodeBackupKey(Buffer.alloc(32, 11).toString('base64url'));

function clone(value) {
  return structuredClone(value);
}

function memoryServices({ projectId = 'self-host-project', bucket = 'self-host-media' } = {}) {
  const documents = new Map();
  const users = new Map();
  const objects = new Map();
  const state = { documents, users, objects, importedHashConfig: null, migrationRuns: [] };
  const services = {
    projectId,
    bucket,
    firestore: {
      get: async (documentPath) => documents.has(documentPath) ? clone(documents.get(documentPath)) : null,
      create: async (documentPath, data) => {
        if (documents.has(documentPath)) return false;
        documents.set(documentPath, clone(data));
        return true;
      },
      update: async (documentPath, data) => {
        documents.set(documentPath, { ...(documents.get(documentPath) ?? {}), ...clone(data) });
      },
      hasAny: async () => documents.size > 0,
      listPaths: async () => [...documents.keys()].sort(),
      listDocuments: async function* () {
        for (const documentPath of [...documents.keys()].sort()) {
          yield { path: documentPath, data: clone(documents.get(documentPath)) };
        }
      },
      writeDocuments: async (records) => {
        for (const record of records) documents.set(record.path, clone(record.data));
      },
      deleteDocuments: async (paths) => {
        for (const documentPath of paths) documents.delete(documentPath);
      },
      acquireMigrationLock: async (documentPath, owner, _startedAt, expiresAt) => {
        const installation = documents.get(documentPath);
        const lock = installation?.migration_lock;
        if (lock && lock.owner !== owner && lock.expires_at > new Date().toISOString()) return false;
        installation.migration_lock = { owner, expires_at: expiresAt };
        return true;
      },
      renewMigrationLock: async (documentPath, owner, expiresAt) => {
        const installation = documents.get(documentPath);
        if (installation?.migration_lock?.owner !== owner) return false;
        installation.migration_lock.expires_at = expiresAt;
        return true;
      },
      releaseMigrationLock: async (documentPath, owner) => {
        const installation = documents.get(documentPath);
        if (installation?.migration_lock?.owner === owner) delete installation.migration_lock;
      },
      types: {},
    },
    auth: {
      hasAny: async () => users.size > 0,
      listUserIds: async () => [...users.keys()].sort(),
      listUsers: async function* () {
        for (const uid of [...users.keys()].sort()) yield clone(users.get(uid));
      },
      getHashConfig: async () => ({
        algorithm: 'HMAC_SHA256',
        signerKey: Buffer.from('test-signer').toString('base64'),
      }),
      importUsers: async (records, hashConfig) => {
        state.importedHashConfig = clone(hashConfig);
        for (const user of records) users.set(user.uid, clone(user));
      },
      deleteUsers: async (ids) => {
        for (const uid of ids) users.delete(uid);
      },
    },
    objects: {
      assertAccessible: async () => {},
      hasAny: async () => objects.size > 0,
      listKeys: async () => [...objects.keys()].sort(),
      list: async function* () {
        for (const key of [...objects.keys()].sort()) {
          const object = objects.get(key);
          yield { key, size: object.body.length, contentType: object.contentType, metadata: object.metadata };
        }
      },
      get: async (key) => Readable.from(objects.get(key).body),
      put: async (object, input) => {
        const chunks = [];
        for await (const chunk of input) chunks.push(Buffer.from(chunk));
        objects.set(object.key, {
          body: Buffer.concat(chunks),
          contentType: object.contentType,
          metadata: object.metadata,
        });
      },
      delete: async (keys) => {
        for (const key of keys) objects.delete(key);
      },
    },
  };
  return { services, state };
}

async function seedSource() {
  const source = memoryServices();
  await bootstrapSelfHost({
    services: source.services,
    now: () => new Date('2026-09-01T08:00:00.000Z'),
    id: () => 'installation-test',
  });
  source.state.documents.set('sites/site-one', {
    name: 'Secret site name',
    bytes: Buffer.from('document-bytes'),
    nested: { nan: Number.NaN, date: new Date('2026-08-31T12:00:00.000Z') },
  });
  source.state.users.set('user-one', {
    uid: 'user-one',
    email: 'private@example.test',
    emailVerified: true,
    passwordHash: Buffer.from('password-hash').toString('base64url'),
    passwordSalt: Buffer.from('salt').toString('base64url'),
    customClaims: { role: 'owner' },
    providerData: [{ providerId: 'password', uid: 'private@example.test' }],
  });
  source.state.objects.set('private/site-one/image.png', {
    body: Buffer.from('secret-object-body'),
    contentType: 'image/png',
    metadata: { source: 'test' },
  });
  return source;
}

async function makeBackup(t) {
  const source = await seedSource();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'typeroll-backup-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const backupDir = path.join(parent, 'backup');
  const manifest = await createSelfHostBackup({
    services: source.services,
    outputDir: backupDir,
    backupKey: BACKUP_KEY,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
    id: () => 'backup-test',
  });
  return { source, backupDir, manifest };
}

test('self-host schema constants remain aligned with the runtime release contract', () => {
  const release = fs.readFileSync(new URL('../packages/shared/src/release.ts', import.meta.url), 'utf8');
  assert.match(release, new RegExp(`CORE_VERSION = '${SELF_HOST_CORE_VERSION}'`));
  assert.match(release, new RegExp(`DATA_SCHEMA_VERSION = ${SELF_HOST_DATA_SCHEMA_VERSION}`));
  assert.match(release, new RegExp(`DATA_SCHEMA_READABLE_MIN = ${SELF_HOST_DATA_SCHEMA_READABLE_MIN}`));
  assert.match(release, new RegExp(`DATA_SCHEMA_READABLE_MAX = ${SELF_HOST_DATA_SCHEMA_READABLE_MAX}`));
});

test('migration planning requires a contiguous, forward-only path', () => {
  const migrations = [
    { id: 'one-to-two', from: 1, to: 2 },
    { id: 'two-to-three', from: 2, to: 3 },
  ];
  assert.deepEqual(planSelfHostMigrations(1, 3, migrations).map((step) => step.id), ['one-to-two', 'two-to-three']);
  assert.throws(() => planSelfHostMigrations(1, 3, migrations.slice(1)), /No migration registered/);
  assert.throws(() => planSelfHostMigrations(2, 1, migrations), /Cannot migrate/);
});

test('bootstrap is idempotent and requires explicit adoption of existing data', async () => {
  const fresh = memoryServices();
  const first = await bootstrapSelfHost({ services: fresh.services, id: () => 'installation-one' });
  const second = await bootstrapSelfHost({ services: fresh.services, id: () => 'installation-two' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.installation.installation_id, 'installation-one');

  const existing = memoryServices();
  existing.state.users.set('existing-user', { uid: 'existing-user' });
  await assert.rejects(bootstrapSelfHost({ services: existing.services }), /--adopt/);
  const adopted = await bootstrapSelfHost({ services: existing.services, adopt: true, id: () => 'adopted' });
  assert.equal(adopted.installation.adopted_existing_data, true);
});

test('backup encrypts all data planes and verifies every encrypted payload', async (t) => {
  const { backupDir, manifest } = await makeBackup(t);
  assert.deepEqual(manifest.counts, {
    firestore_documents: 2,
    auth_users: 1,
    r2_objects: 1,
    r2_bytes: 18,
  });
  const visibleFiles = fs.readdirSync(backupDir, { recursive: true })
    .filter((entry) => fs.statSync(path.join(backupDir, entry)).isFile())
    .map((entry) => fs.readFileSync(path.join(backupDir, entry)))
    .map((input) => input.toString('utf8'))
    .join('\n');
  assert.doesNotMatch(visibleFiles, /private@example\.test|Secret site name|secret-object-body|private\/site-one/);
  const verified = await verifySelfHostBackup({ backupDir, backupKey: BACKUP_KEY });
  assert.equal(verified.manifest.backup_id, 'backup-test');
  await assert.rejects(
    verifySelfHostBackup({ backupDir, backupKey: Buffer.alloc(32, 12) }),
    /authentication failed/,
  );
});

test('backup tampering and interrupted backups are never accepted', async (t) => {
  const { backupDir, manifest } = await makeBackup(t);
  fs.appendFileSync(path.join(backupDir, manifest.files.firestore.file), Buffer.from('tampered'));
  await assert.rejects(verifySelfHostBackup({ backupDir, backupKey: BACKUP_KEY }), /checksum mismatch/);

  const source = await seedSource();
  source.services.auth.listUsers = async function* () {
    throw new Error('simulated Auth failure');
  };
  const failedDir = path.join(path.dirname(backupDir), 'failed');
  await assert.rejects(
    createSelfHostBackup({ services: source.services, outputDir: failedDir, backupKey: BACKUP_KEY }),
    /simulated Auth failure/,
  );
  assert.equal(fs.existsSync(path.join(failedDir, 'INCOMPLETE')), true);
  await assert.rejects(verifySelfHostBackup({ backupDir: failedDir, backupKey: BACKUP_KEY }), /marked incomplete/);
});

test('restore recreates Firestore, Auth, and R2 and rejects non-empty safe mode', async (t) => {
  const { backupDir } = await makeBackup(t);
  const target = memoryServices();
  await restoreSelfHostBackup({
    services: target.services,
    backupDir,
    backupKey: BACKUP_KEY,
    mode: 'empty',
    now: () => new Date('2026-09-01T10:00:00.000Z'),
  });
  assert.equal(target.state.documents.get('sites/site-one').name, 'Secret site name');
  assert.deepEqual(target.state.users.get('user-one').customClaims, { role: 'owner' });
  assert.equal(target.state.objects.get('private/site-one/image.png').body.toString(), 'secret-object-body');
  assert.equal(target.state.importedHashConfig.algorithm, 'HMAC_SHA256');
  assert.equal(target.state.documents.get(SELF_HOST_INSTALLATION_PATH).firebase_project_id, 'self-host-project');

  await assert.rejects(
    restoreSelfHostBackup({ services: target.services, backupDir, backupKey: BACKUP_KEY, mode: 'empty' }),
    /target is not empty/,
  );
});

test('replace restore removes records not present in the backup', async (t) => {
  const { backupDir } = await makeBackup(t);
  const target = memoryServices();
  target.state.documents.set('obsolete/doc', { obsolete: true });
  target.state.users.set('obsolete-user', { uid: 'obsolete-user' });
  target.state.objects.set('obsolete.bin', { body: Buffer.from('old') });
  await restoreSelfHostBackup({ services: target.services, backupDir, backupKey: BACKUP_KEY, mode: 'replace' });
  assert.equal(target.state.documents.has('obsolete/doc'), false);
  assert.equal(target.state.users.has('obsolete-user'), false);
  assert.equal(target.state.objects.has('obsolete.bin'), false);
  assert.deepEqual(await target.services.auth.listUserIds(), ['user-one']);
});

test('migrations require a matching verified backup and advance metadata stepwise', async (t) => {
  const { source, backupDir } = await makeBackup(t);
  const migrations = [
    { id: 'one-to-two', from: 1, to: 2, run: async () => source.state.migrationRuns.push('one-to-two') },
    { id: 'two-to-three', from: 2, to: 3, run: async () => source.state.migrationRuns.push('two-to-three') },
  ];
  const status = await migrationStatus({ services: source.services, migrations, targetVersion: 3 });
  assert.deepEqual(status.steps.map((step) => step.id), ['one-to-two', 'two-to-three']);
  await assert.rejects(
    applySelfHostMigrations({ services: source.services, migrations, targetVersion: 3 }),
    /verified pre-migration backup/,
  );
  const verifiedBackup = await verifySelfHostBackup({ backupDir, backupKey: BACKUP_KEY });
  const result = await applySelfHostMigrations({
    services: source.services,
    migrations,
    targetVersion: 3,
    verifiedBackup,
    owner: 'migration-test',
  });
  assert.deepEqual(result.applied, ['one-to-two', 'two-to-three']);
  assert.deepEqual(source.state.migrationRuns, ['one-to-two', 'two-to-three']);
  assert.equal(result.installation.data_schema_version, 3);
  assert.equal(result.installation.migration_lock, undefined);
});
