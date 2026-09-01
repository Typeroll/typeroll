import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

import {
  SELF_HOST_BACKUP_FORMAT_VERSION,
  SELF_HOST_DATA_SCHEMA_READABLE_MAX,
  SELF_HOST_DATA_SCHEMA_READABLE_MIN,
  SELF_HOST_INSTALLATION_PATH,
} from './self-host-schema.mjs';

const KEY_CONTEXT = Buffer.from('typeroll-self-host-backup-v1');

function asReadable(input) {
  if (input instanceof Readable) return input;
  if (typeof input?.transformToWebStream === 'function') return Readable.fromWeb(input.transformToWebStream());
  if (input?.getReader) return Readable.fromWeb(input);
  if (input?.[Symbol.asyncIterator] || input?.[Symbol.iterator]) return Readable.from(input);
  throw new Error('Backup source is not a readable stream');
}

export function decodeBackupKey(input) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input ?? '')) {
    throw new Error('TYPEROLL_BACKUP_KEY must be a base64url-encoded 32-byte key');
  }
  const key = Buffer.from(input, 'base64url');
  if (key.length !== 32) throw new Error('TYPEROLL_BACKUP_KEY must decode to 32 bytes');
  return key;
}

function deriveKeys(masterKey) {
  return {
    encryption: Buffer.from(hkdfSync('sha256', masterKey, KEY_CONTEXT, Buffer.from('encryption'), 32)),
    manifest: Buffer.from(hkdfSync('sha256', masterKey, KEY_CONTEXT, Buffer.from('manifest'), 32)),
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalManifest(manifest) {
  const { manifest_hmac: _hmac, ...unsigned } = manifest;
  return JSON.stringify(unsigned);
}

function signManifest(manifest, key) {
  return createHmac('sha256', key).update(canonicalManifest(manifest)).digest('hex');
}

function assertSafeRelativeFile(input) {
  if (!input || path.isAbsolute(input) || input.includes('..') || input.includes('\\')) {
    throw new Error(`Backup contains an unsafe file path: ${input}`);
  }
}

class EncryptedWriter {
  constructor(filePath, encryptionKey) {
    this.filePath = filePath;
    this.nonce = randomBytes(12);
    this.cipher = createCipheriv('aes-256-gcm', encryptionKey, this.nonce);
    this.ciphertextHash = createHash('sha256');
    this.plaintextHash = createHash('sha256');
    this.plaintextBytes = 0;
    this.hashing = new Transform({
      transform: (chunk, _encoding, callback) => {
        this.ciphertextHash.update(chunk);
        callback(null, chunk);
      },
    });
    this.output = fs.createWriteStream(filePath, { mode: 0o600 });
    this.cipher.pipe(this.hashing).pipe(this.output);
  }

  async write(input) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    this.plaintextHash.update(chunk);
    this.plaintextBytes += chunk.length;
    if (!this.cipher.write(chunk)) await once(this.cipher, 'drain');
  }

  async finish() {
    this.cipher.end();
    await finished(this.output);
    return {
      file: path.basename(this.filePath),
      algorithm: 'aes-256-gcm',
      nonce: this.nonce.toString('base64url'),
      tag: this.cipher.getAuthTag().toString('base64url'),
      plaintext_bytes: this.plaintextBytes,
      plaintext_sha256: this.plaintextHash.digest('hex'),
      ciphertext_sha256: this.ciphertextHash.digest('hex'),
    };
  }

  async abort() {
    this.cipher.destroy();
    this.hashing.destroy();
    this.output.destroy();
    await Promise.allSettled([finished(this.output)]);
  }
}

async function encryptStream(input, filePath, encryptionKey) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  const plaintextHash = createHash('sha256');
  const ciphertextHash = createHash('sha256');
  let plaintextBytes = 0;
  const beforeCipher = new Transform({
    transform(chunk, _encoding, callback) {
      plaintextHash.update(chunk);
      plaintextBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const afterCipher = new Transform({
    transform(chunk, _encoding, callback) {
      ciphertextHash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    asReadable(input),
    beforeCipher,
    cipher,
    afterCipher,
    fs.createWriteStream(filePath, { mode: 0o600 }),
  );
  return {
    file: path.relative(path.dirname(path.dirname(filePath)), filePath).split(path.sep).join('/'),
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    plaintext_bytes: plaintextBytes,
    plaintext_sha256: plaintextHash.digest('hex'),
    ciphertext_sha256: ciphertextHash.digest('hex'),
  };
}

function decryptedStream(backupDir, descriptor, encryptionKey) {
  assertSafeRelativeFile(descriptor.file);
  const inputPath = path.resolve(backupDir, descriptor.file);
  if (!inputPath.startsWith(`${path.resolve(backupDir)}${path.sep}`)) throw new Error('Backup file escapes its directory');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(descriptor.nonce, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(descriptor.tag, 'base64url'));
  return fs.createReadStream(inputPath).pipe(decipher);
}

async function verifyEncryptedFile(backupDir, descriptor, encryptionKey) {
  assertSafeRelativeFile(descriptor.file);
  const filePath = path.resolve(backupDir, descriptor.file);
  if (!fs.existsSync(filePath)) throw new Error(`Backup file is missing: ${descriptor.file}`);
  if (await sha256File(filePath) !== descriptor.ciphertext_sha256) {
    throw new Error(`Ciphertext checksum mismatch: ${descriptor.file}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const sink = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback();
    },
  });
  await pipeline(decryptedStream(backupDir, descriptor, encryptionKey), sink);
  if (bytes !== descriptor.plaintext_bytes || hash.digest('hex') !== descriptor.plaintext_sha256) {
    throw new Error(`Plaintext checksum mismatch: ${descriptor.file}`);
  }
}

export function encodeFirestoreValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'nan'];
    if (value === Infinity) return ['number', 'infinity'];
    if (value === -Infinity) return ['number', '-infinity'];
    return ['number', value];
  }
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (Array.isArray(value)) return ['array', value.map(encodeFirestoreValue)];
  if (typeof value === 'object') {
    if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number' && value.constructor?.name === 'Timestamp') {
      return ['timestamp', value.seconds, value.nanoseconds];
    }
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && value.constructor?.name === 'GeoPoint') {
      return ['geopoint', value.latitude, value.longitude];
    }
    if (typeof value.path === 'string' && value.constructor?.name === 'DocumentReference') {
      return ['reference', value.path];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Unsupported Firestore value type: ${value.constructor?.name ?? 'unknown'}`);
    }
    return ['map', Object.keys(value).sort().map((key) => [key, encodeFirestoreValue(value[key])])];
  }
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

export function decodeFirestoreValue(encoded, types = {}) {
  if (!Array.isArray(encoded) || typeof encoded[0] !== 'string') throw new Error('Invalid encoded Firestore value');
  switch (encoded[0]) {
    case 'null': return null;
    case 'string': return encoded[1];
    case 'boolean': return encoded[1];
    case 'number':
      if (encoded[1] === 'nan') return Number.NaN;
      if (encoded[1] === 'infinity') return Infinity;
      if (encoded[1] === '-infinity') return -Infinity;
      return encoded[1];
    case 'date': return new Date(encoded[1]);
    case 'bytes': return Buffer.from(encoded[1], 'base64');
    case 'array': return encoded[1].map((value) => decodeFirestoreValue(value, types));
    case 'map': return Object.fromEntries(encoded[1].map(([key, value]) => [key, decodeFirestoreValue(value, types)]));
    case 'timestamp': return types.timestamp ? types.timestamp(encoded[1], encoded[2]) : { seconds: encoded[1], nanoseconds: encoded[2] };
    case 'geopoint': return types.geopoint ? types.geopoint(encoded[1], encoded[2]) : { latitude: encoded[1], longitude: encoded[2] };
    case 'reference': return types.reference ? types.reference(encoded[1]) : { path: encoded[1] };
    default: throw new Error(`Unknown Firestore backup value tag: ${encoded[0]}`);
  }
}

async function* jsonLines(stream) {
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) yield JSON.parse(line);
  }
}

function userHasPasswordProvider(user) {
  return (user.providerData ?? []).some((provider) => provider.providerId === 'password');
}

export async function createSelfHostBackup({ services, outputDir, backupKey, now = () => new Date(), id = randomUUID }) {
  const absolute = path.resolve(outputDir);
  fs.mkdirSync(absolute, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(absolute, 'INCOMPLETE'), 'Backup did not complete. Do not restore from this directory.\n', { mode: 0o600 });
  fs.mkdirSync(path.join(absolute, 'objects'), { mode: 0o700 });
  const keys = deriveKeys(backupKey);

  let activeWriter;
  try {
    const installation = await services.firestore.get(SELF_HOST_INSTALLATION_PATH);
    if (!installation) throw new Error('Installation is not bootstrapped');
    await services.objects.assertAccessible();

    activeWriter = new EncryptedWriter(path.join(absolute, 'firestore.jsonl.enc'), keys.encryption);
    let documentCount = 0;
    for await (const document of services.firestore.listDocuments()) {
      await activeWriter.write(`${JSON.stringify({ path: document.path, data: encodeFirestoreValue(document.data) })}\n`);
      documentCount += 1;
    }
    const firestoreFile = await activeWriter.finish();
    activeWriter = undefined;

    const hashConfig = await services.auth.getHashConfig();
    if (!hashConfig?.algorithm) throw new Error('Firebase Auth hash configuration is unavailable');
    activeWriter = new EncryptedWriter(path.join(absolute, 'auth.jsonl.enc'), keys.encryption);
    await activeWriter.write(`${JSON.stringify({ kind: 'hash_config', value: hashConfig })}\n`);
    let userCount = 0;
    for await (const user of services.auth.listUsers()) {
      if (userHasPasswordProvider(user) && !user.passwordHash) {
        throw new Error('Firebase Auth password hashes are redacted; grant firebaseauth.configs.getHashConfig before backup');
      }
      await activeWriter.write(`${JSON.stringify({ kind: 'user', value: user })}\n`);
      userCount += 1;
    }
    const authFile = await activeWriter.finish();
    activeWriter = undefined;

    activeWriter = new EncryptedWriter(path.join(absolute, 'objects.jsonl.enc'), keys.encryption);
    let objectCount = 0;
    let objectBytes = 0;
    for await (const object of services.objects.list()) {
      const name = `${String(objectCount).padStart(10, '0')}.enc`;
      const encrypted = await encryptStream(
        await services.objects.get(object.key),
        path.join(absolute, 'objects', name),
        keys.encryption,
      );
      await activeWriter.write(`${JSON.stringify({ ...object, encrypted })}\n`);
      objectCount += 1;
      objectBytes += object.size;
    }
    const objectIndexFile = await activeWriter.finish();
    activeWriter = undefined;

    const manifest = {
      format_version: SELF_HOST_BACKUP_FORMAT_VERSION,
      backup_id: id(),
      created_at: now().toISOString(),
      source: { firebase_project_id: services.projectId, r2_bucket: services.bucket },
      data_schema_version: installation.data_schema_version,
      counts: { firestore_documents: documentCount, auth_users: userCount, r2_objects: objectCount, r2_bytes: objectBytes },
      files: { firestore: firestoreFile, auth: authFile, object_index: objectIndexFile },
    };
    manifest.manifest_hmac = signManifest(manifest, keys.manifest);
    fs.writeFileSync(path.join(absolute, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.unlinkSync(path.join(absolute, 'INCOMPLETE'));
    return manifest;
  } catch (error) {
    if (activeWriter) await activeWriter.abort();
    throw error;
  }
}

function readManifest(backupDir) {
  const manifestPath = path.join(path.resolve(backupDir), 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Backup manifest is missing');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export async function verifySelfHostBackup({ backupDir, backupKey }) {
  const absolute = path.resolve(backupDir);
  if (fs.existsSync(path.join(absolute, 'INCOMPLETE'))) throw new Error('Backup is marked incomplete');
  const manifest = readManifest(absolute);
  if (manifest.format_version !== SELF_HOST_BACKUP_FORMAT_VERSION) throw new Error(`Unsupported backup format ${manifest.format_version}`);
  if (
    manifest.data_schema_version < SELF_HOST_DATA_SCHEMA_READABLE_MIN ||
    manifest.data_schema_version > SELF_HOST_DATA_SCHEMA_READABLE_MAX
  ) {
    throw new Error(`Backup data schema ${manifest.data_schema_version} is not readable by this Core release`);
  }
  const keys = deriveKeys(backupKey);
  const expectedHmac = Buffer.from(signManifest(manifest, keys.manifest), 'hex');
  const actualHmac = Buffer.from(manifest.manifest_hmac ?? '', 'hex');
  if (actualHmac.length !== expectedHmac.length || !timingSafeEqual(actualHmac, expectedHmac)) {
    throw new Error('Backup manifest authentication failed');
  }
  await verifyEncryptedFile(absolute, manifest.files.firestore, keys.encryption);
  await verifyEncryptedFile(absolute, manifest.files.auth, keys.encryption);
  await verifyEncryptedFile(absolute, manifest.files.object_index, keys.encryption);

  let documentCount = 0;
  const documentPaths = new Set();
  for await (const record of jsonLines(decryptedStream(absolute, manifest.files.firestore, keys.encryption))) {
    if (typeof record.path !== 'string' || record.path.split('/').length % 2 !== 0) throw new Error('Backup contains an invalid Firestore document path');
    if (documentPaths.has(record.path)) throw new Error(`Backup contains duplicate Firestore path ${record.path}`);
    decodeFirestoreValue(record.data);
    documentPaths.add(record.path);
    documentCount += 1;
  }

  let userCount = 0;
  let hashConfigCount = 0;
  const userIds = new Set();
  for await (const record of jsonLines(decryptedStream(absolute, manifest.files.auth, keys.encryption))) {
    if (record.kind === 'hash_config') hashConfigCount += 1;
    else if (record.kind === 'user') {
      if (!record.value?.uid || userIds.has(record.value.uid)) throw new Error('Backup contains an invalid or duplicate Auth user');
      userIds.add(record.value.uid);
      userCount += 1;
    } else throw new Error('Backup contains an unknown Auth record');
  }
  if (hashConfigCount !== 1) throw new Error('Backup must contain exactly one Firebase Auth hash configuration');

  let objectCount = 0;
  let objectBytes = 0;
  const objectKeys = new Set();
  for await (const object of jsonLines(decryptedStream(absolute, manifest.files.object_index, keys.encryption))) {
    if (!object.key || objectKeys.has(object.key) || !object.encrypted) throw new Error('Backup contains an invalid or duplicate R2 object');
    objectKeys.add(object.key);
    await verifyEncryptedFile(absolute, object.encrypted, keys.encryption);
    objectCount += 1;
    objectBytes += object.size;
  }

  const actual = { firestore_documents: documentCount, auth_users: userCount, r2_objects: objectCount, r2_bytes: objectBytes };
  if (JSON.stringify(actual) !== JSON.stringify(manifest.counts)) throw new Error('Backup counts do not match the verified contents');
  return { manifest, documentPaths, userIds, objectKeys };
}

export async function restoreSelfHostBackup({ services, backupDir, backupKey, mode, now = () => new Date() }) {
  if (mode !== 'empty' && mode !== 'replace') throw new Error('Restore mode must be empty or replace');
  const verified = await verifySelfHostBackup({ backupDir, backupKey });
  const { manifest } = verified;
  const currentDocumentPaths = await services.firestore.listPaths();
  const currentUserIds = await services.auth.listUserIds();
  const currentObjectKeys = await services.objects.listKeys();
  if (mode === 'empty' && (currentDocumentPaths.length || currentUserIds.length || currentObjectKeys.length)) {
    throw new Error('Restore target is not empty');
  }

  const absolute = path.resolve(backupDir);
  const keys = deriveKeys(backupKey);
  const documentBatch = [];
  for await (const record of jsonLines(decryptedStream(absolute, manifest.files.firestore, keys.encryption))) {
    documentBatch.push({ path: record.path, data: decodeFirestoreValue(record.data, services.firestore.types) });
    if (documentBatch.length === 400) await services.firestore.writeDocuments(documentBatch.splice(0));
  }
  if (documentBatch.length) await services.firestore.writeDocuments(documentBatch);

  let hashConfig;
  const users = [];
  for await (const record of jsonLines(decryptedStream(absolute, manifest.files.auth, keys.encryption))) {
    if (record.kind === 'hash_config') hashConfig = record.value;
    else users.push(record.value);
  }
  for await (const object of jsonLines(decryptedStream(absolute, manifest.files.object_index, keys.encryption))) {
    await services.objects.put(object, decryptedStream(absolute, object.encrypted, keys.encryption));
  }

  if (mode === 'replace') {
    const extraDocuments = currentDocumentPaths.filter((documentPath) => !verified.documentPaths.has(documentPath));
    const extraObjects = currentObjectKeys.filter((key) => !verified.objectKeys.has(key));
    if (extraDocuments.length) await services.firestore.deleteDocuments(extraDocuments);
    if (extraObjects.length) await services.objects.delete(extraObjects);
  }

  if (mode === 'replace' && currentUserIds.length) await services.auth.deleteUsers(currentUserIds);
  await services.auth.importUsers(users, hashConfig);

  const [restoredDocumentPaths, restoredUserIds, restoredObjectKeys] = await Promise.all([
    services.firestore.listPaths(),
    services.auth.listUserIds(),
    services.objects.listKeys(),
  ]);
  const matches = (actual, expected) =>
    actual.length === expected.size && actual.every((value) => expected.has(value));
  if (
    !matches(restoredDocumentPaths, verified.documentPaths) ||
    !matches(restoredUserIds, verified.userIds) ||
    !matches(restoredObjectKeys, verified.objectKeys)
  ) {
    throw new Error('Restore verification failed: target record sets do not match the backup');
  }

  await services.firestore.update(SELF_HOST_INSTALLATION_PATH, {
    firebase_project_id: services.projectId,
    r2_bucket: services.bucket,
    restored_at: now().toISOString(),
    restored_from_backup_id: manifest.backup_id,
    restored_from_project_id: manifest.source.firebase_project_id,
  });
  return manifest;
}
