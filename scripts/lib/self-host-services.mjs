import { randomUUID } from 'node:crypto';

function required(env, key) {
  const input = env[key]?.trim();
  if (!input) throw new Error(`${key} is required`);
  return input;
}

export function resolveFirebaseAdminTarget(env) {
  const rawServiceAccount = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  let credentials = null;
  if (rawServiceAccount) {
    try {
      credentials = JSON.parse(rawServiceAccount);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT must contain valid JSON');
    }
    if (!credentials?.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT must contain a project_id');
  }
  const projectId = credentials?.project_id ?? env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_CLOUD_PROJECT with Application Default Credentials');
  }
  const publicProjectId = env.PUBLIC_FIREBASE_PROJECT_ID?.trim();
  if (publicProjectId && publicProjectId !== projectId) {
    throw new Error('PUBLIC_FIREBASE_PROJECT_ID must match the Firebase administration project');
  }
  return { projectId, credentials };
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function importableUser(user) {
  const record = { uid: user.uid };
  for (const key of ['email', 'emailVerified', 'displayName', 'photoURL', 'phoneNumber', 'disabled', 'customClaims', 'tenantId', 'multiFactor']) {
    if (user[key] !== undefined && user[key] !== null) record[key] = user[key];
  }
  if (user.metadata) {
    record.metadata = Object.fromEntries(
      ['creationTime', 'lastSignInTime', 'lastRefreshTime']
        .filter((key) => user.metadata[key] !== undefined && user.metadata[key] !== null)
        .map((key) => [key, user.metadata[key]]),
    );
  }
  if (user.providerData) {
    record.providerData = user.providerData.map((provider) => Object.fromEntries(
      ['uid', 'displayName', 'email', 'photoURL', 'providerId', 'phoneNumber']
        .filter((key) => provider[key] !== undefined && provider[key] !== null)
        .map((key) => [key, provider[key]]),
    ));
  }
  if (user.passwordHash) record.passwordHash = Buffer.from(user.passwordHash, 'base64url');
  if (user.passwordSalt) record.passwordSalt = Buffer.from(user.passwordSalt, 'base64url');
  return record;
}

export async function createSelfHostServices(env) {
  const { projectId, credentials } = resolveFirebaseAdminTarget(env);
  const bucket = required(env, 'R2_BUCKET');

  const [{ initializeApp, cert, applicationDefault }, { getFirestore, FieldPath, Timestamp, GeoPoint }, { getAuth }, { GoogleAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
    import('firebase-admin/auth'),
    import('google-auth-library'),
  ]);
  const app = initializeApp(
    { credential: credentials ? cert(credentials) : applicationDefault(), projectId },
    `typeroll-self-host-ops-${randomUUID()}`,
  );
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const auth = getAuth(app);

  const { S3Client, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${required(env, 'R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
    },
  });

  async function* walkCollection(collection) {
    let cursor;
    for (;;) {
      let query = collection.orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      for (const document of snapshot.docs) {
        yield { path: document.ref.path, data: document.data() };
        const subcollections = await document.ref.listCollections();
        subcollections.sort((left, right) => left.id.localeCompare(right.id));
        for (const subcollection of subcollections) yield* walkCollection(subcollection);
      }
      cursor = snapshot.docs.at(-1);
      if (snapshot.size < 200) break;
    }
  }

  async function* listDocuments() {
    const roots = await db.listCollections();
    roots.sort((left, right) => left.id.localeCompare(right.id));
    for (const root of roots) yield* walkCollection(root);
  }

  async function listDocumentPaths() {
    const paths = [];
    for await (const document of listDocuments()) paths.push(document.path);
    return paths;
  }

  async function hasAnyDocument() {
    const roots = await db.listCollections();
    for (const root of roots) {
      if (!(await root.limit(1).get()).empty) return true;
    }
    return false;
  }

  async function writeDocuments(documents) {
    for (const batchRecords of chunk(documents, 400)) {
      const batch = db.batch();
      for (const document of batchRecords) batch.set(db.doc(document.path), document.data);
      await batch.commit();
    }
  }

  async function deleteDocuments(paths) {
    const ordered = [...paths].sort((left, right) => right.split('/').length - left.split('/').length);
    for (const batchPaths of chunk(ordered, 400)) {
      const batch = db.batch();
      for (const documentPath of batchPaths) batch.delete(db.doc(documentPath));
      await batch.commit();
    }
  }

  async function acquireMigrationLock(documentPath, owner, nowIso, expiresAt) {
    return db.runTransaction(async (transaction) => {
      const ref = db.doc(documentPath);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error('Installation is not bootstrapped');
      const existing = snapshot.data()?.migration_lock;
      if (existing?.expires_at && existing.expires_at > nowIso && existing.owner !== owner) return false;
      transaction.set(ref, { migration_lock: { owner, expires_at: expiresAt } }, { merge: true });
      return true;
    });
  }

  async function releaseMigrationLock(documentPath, owner) {
    const { FieldValue } = await import('firebase-admin/firestore');
    await db.runTransaction(async (transaction) => {
      const ref = db.doc(documentPath);
      const snapshot = await transaction.get(ref);
      if (snapshot.data()?.migration_lock?.owner === owner) {
        transaction.set(ref, { migration_lock: FieldValue.delete() }, { merge: true });
      }
    });
  }

  async function renewMigrationLock(documentPath, owner, expiresAt) {
    return db.runTransaction(async (transaction) => {
      const ref = db.doc(documentPath);
      const snapshot = await transaction.get(ref);
      if (snapshot.data()?.migration_lock?.owner !== owner) return false;
      transaction.set(ref, { migration_lock: { owner, expires_at: expiresAt } }, { merge: true });
      return true;
    });
  }

  async function* listUsers() {
    let pageToken;
    do {
      const page = await auth.listUsers(1000, pageToken);
      for (const user of page.users) yield user.toJSON();
      pageToken = page.pageToken;
    } while (pageToken);
  }

  async function getAuthHashConfig() {
    const googleAuth = new GoogleAuth({
      ...(credentials ? { credentials } : {}),
      projectId,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await googleAuth.getClient();
    const response = await client.request({
      url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(projectId)}/config`,
    });
    return response.data?.signIn?.hashConfig ?? null;
  }

  async function importUsers(users, hashConfig) {
    const options = hashConfig ? {
      hash: {
        algorithm: hashConfig.algorithm,
        key: hashConfig.signerKey ? Buffer.from(hashConfig.signerKey, 'base64') : undefined,
        saltSeparator: hashConfig.saltSeparator ? Buffer.from(hashConfig.saltSeparator, 'base64') : undefined,
        rounds: hashConfig.rounds,
        memoryCost: hashConfig.memoryCost,
      },
    } : undefined;
    for (const userBatch of chunk(users, 1000)) {
      const result = await auth.importUsers(userBatch.map(importableUser), options);
      if (result.failureCount > 0) {
        throw new Error(`Firebase Auth rejected ${result.failureCount} user records`);
      }
    }
  }

  async function listUserIds() {
    const ids = [];
    for await (const user of listUsers()) ids.push(user.uid);
    return ids;
  }


  async function hasAnyUser() {
    return (await auth.listUsers(1)).users.length > 0;
  }

  async function deleteUsers(ids) {
    for (const idBatch of chunk(ids, 1000)) {
      const result = await auth.deleteUsers(idBatch);
      if (result.failureCount > 0) throw new Error(`Firebase Auth rejected ${result.failureCount} user deletions`);
    }
  }

  async function* listObjects() {
    let continuationToken;
    do {
      const page = await r2.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: item.Key }));
        yield {
          key: item.Key,
          size: item.Size ?? head.ContentLength ?? 0,
          etag: item.ETag,
          contentType: head.ContentType,
          cacheControl: head.CacheControl,
          contentDisposition: head.ContentDisposition,
          contentEncoding: head.ContentEncoding,
          contentLanguage: head.ContentLanguage,
          metadata: head.Metadata,
        };
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }

  async function getObject(key) {
    const result = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`R2 returned no body for object ${key}`);
    return result.Body;
  }

  async function putObject(object, body) {
    await r2.send(new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: body,
      ContentLength: object.size,
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
      ContentDisposition: object.contentDisposition,
      ContentEncoding: object.contentEncoding,
      ContentLanguage: object.contentLanguage,
      Metadata: object.metadata,
    }));
  }

  async function listObjectKeys() {
    const keys = [];
    for await (const object of listObjects()) keys.push(object.key);
    return keys;
  }


  async function hasAnyObject() {
    return (await r2.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))).KeyCount > 0;
  }

  async function deleteObjects(keys) {
    for (const keyBatch of chunk(keys, 1000)) {
      const result = await r2.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keyBatch.map((Key) => ({ Key })), Quiet: true },
      }));
      if ((result.Errors ?? []).length > 0) throw new Error(`R2 rejected ${result.Errors.length} object deletions`);
    }
  }

  return {
    projectId,
    bucket,
    firestore: {
      get: async (documentPath) => {
        const snapshot = await db.doc(documentPath).get();
        return snapshot.exists ? snapshot.data() : null;
      },
      create: async (documentPath, data) => {
        try {
          await db.doc(documentPath).create(data);
          return true;
        } catch (error) {
          if (error?.code === 6 || error?.code === 'already-exists') return false;
          throw error;
        }
      },
      update: async (documentPath, data) => db.doc(documentPath).set(data, { merge: true }),
      listDocuments,
      listPaths: listDocumentPaths,
      hasAny: hasAnyDocument,
      writeDocuments,
      deleteDocuments,
      acquireMigrationLock,
      renewMigrationLock,
      releaseMigrationLock,
      types: {
        timestamp: (seconds, nanoseconds) => new Timestamp(seconds, nanoseconds),
        geopoint: (latitude, longitude) => new GeoPoint(latitude, longitude),
        reference: (documentPath) => db.doc(documentPath),
      },
    },
    auth: { listUsers, listUserIds, hasAny: hasAnyUser, getHashConfig: getAuthHashConfig, importUsers, deleteUsers },
    objects: {
      assertAccessible: async () => r2.send(new HeadBucketCommand({ Bucket: bucket })),
      list: listObjects,
      listKeys: listObjectKeys,
      hasAny: hasAnyObject,
      get: getObject,
      put: putObject,
      delete: deleteObjects,
    },
  };
}
