import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PERSONA_MANIFEST = path.join(ROOT, 'config', 'e2e-personas.json');
export const DEFAULT_FIXTURE_ROOT = path.join(ROOT, 'packages', 'site-template', 'fixtures');

export function readPersonaManifest(manifestPath = DEFAULT_PERSONA_MANIFEST) {
  return validatePersonaManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

export function validatePersonaManifest(manifest) {
  if (manifest?.schema_version !== 1) throw new Error('Unsupported E2E persona manifest schema');
  if (!manifest.namespace || !manifest.core_fixture?.owner_org_id || !manifest.core_fixture?.site_id) {
    throw new Error('E2E persona manifest is missing its namespace or Core fixture identifiers');
  }
  if (!Array.isArray(manifest.personas)) throw new Error('E2E persona manifest has no personas');
  const ids = new Set();
  for (const persona of manifest.personas) {
    if (!/^[a-z][a-z0-9_]*$/.test(persona.id ?? '') || ids.has(persona.id)) {
      throw new Error(`Invalid or duplicate E2E persona id: ${persona.id ?? 'missing'}`);
    }
    ids.add(persona.id);
    if (!['core', 'cloud_control_plane', 'cloud_apps'].includes(persona.managed_by)) {
      throw new Error(`E2E persona ${persona.id} has an invalid manager`);
    }
    if (!persona.email_env || !persona.password_env) {
      throw new Error(`E2E persona ${persona.id} is missing credential environment keys`);
    }
    if (persona.managed_by === 'core' && !persona.uid) {
      throw new Error(`Core E2E persona ${persona.id} is missing a stable uid`);
    }
  }
  for (const required of ['owner', 'editor', 'viewer', 'outsider', 'pending', 'operator', 'app_entitled', 'app_unentitled']) {
    if (!ids.has(required)) throw new Error(`E2E persona manifest is missing ${required}`);
  }
  return manifest;
}

export function corePersonas(manifest) {
  return manifest.personas.filter((persona) => persona.managed_by === 'core');
}

export function localPersonaCredentials(manifest) {
  return Object.fromEntries(corePersonas(manifest).map((persona) => [persona.id, {
    email: `${persona.id}@e2e.typeroll.local`,
  }]));
}

export function remotePersonaCredentials(manifest, env) {
  const credentials = Object.fromEntries(corePersonas(manifest).map((persona) => {
    const email = env[persona.email_env]?.trim();
    const password = env[persona.password_env];
    if (!email || !email.includes('@')) throw new Error(`${persona.email_env} must contain an email address`);
    if (!password || password.length < 32) throw new Error(`${persona.password_env} must be at least 32 characters`);
    return [persona.id, { email, password }];
  }));
  const emails = Object.values(credentials).map(({ email }) => email.toLowerCase());
  const passwords = Object.values(credentials).map(({ password }) => password);
  if (new Set(emails).size !== emails.length) throw new Error('Remote E2E persona email addresses must be unique');
  if (new Set(passwords).size !== passwords.length) throw new Error('Remote E2E persona passwords must be unique');
  return credentials;
}

export function remoteApiKeyCredential(env) {
  const token = env.TYPEROLL_E2E_API_KEY?.trim();
  const match = /^typeroll_live_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(token ?? '');
  if (!match) {
    throw new Error('TYPEROLL_E2E_API_KEY must be a valid site-scoped Typeroll API key');
  }
  return {
    token,
    prefix: match[1],
    keyHash: crypto.createHash('sha256').update(match[2]).digest('hex'),
  };
}

export function readSecurePersonaEnvFile(filePath, baseEnv = process.env) {
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode !== 0o600) throw new Error(`E2E credential file must have mode 0600, received ${mode.toString(8).padStart(4, '0')}`);
  return { ...baseEnv, ...parseEnv(fs.readFileSync(filePath, 'utf8')) };
}

export function buildCoreIdentityDocuments(manifest, credentials, now = () => new Date()) {
  const fixture = manifest.core_fixture;
  const timestamp = now().toISOString();
  const documents = new Map([
    [`organizations/${fixture.owner_org_id}`, {
      name: 'Typeroll E2E Core', slug: fixture.owner_org_id, plan: 'enterprise', roles_enforced: true, created_at: timestamp,
    }],
    [`organizations/${fixture.viewer_org_id}`, {
      name: 'Typeroll E2E Viewer', slug: fixture.viewer_org_id, plan: 'free', roles_enforced: true, created_at: timestamp,
    }],
    [`organizations/${fixture.outsider_org_id}`, {
      name: 'Typeroll E2E Outsider', slug: fixture.outsider_org_id, plan: 'free', roles_enforced: true, created_at: timestamp,
    }],
  ]);
  for (const persona of corePersonas(manifest)) {
    if (!persona.org_id || !persona.member_role) continue;
    documents.set(`organizations/${persona.org_id}/members/${persona.uid}`, {
      email: credentials[persona.id].email,
      role: persona.member_role,
      firebase_uid: persona.uid,
      display_name: `E2E ${persona.id}`,
      joined_at: timestamp,
      is_test_account: true,
      e2e_persona: persona.id,
    });
  }
  const share = {
    site_id: fixture.site_id,
    owner_org_id: fixture.owner_org_id,
    shared_with_org_id: fixture.viewer_org_id,
    permission: 'read',
    created_at: now().valueOf(),
    created_by: 'typeroll-e2e-seed',
    label: 'Permanent E2E viewer access',
  };
  documents.set(`organizations/${fixture.owner_org_id}/sites/${fixture.site_id}/shares/e2e-viewer`, share);
  documents.set(`org_share_index/${fixture.viewer_org_id}/shares/e2e-viewer`, share);
  return documents;
}

export function buildRemoteApiKeyDocuments(manifest, env, now = () => new Date()) {
  const fixture = manifest.core_fixture;
  const credential = remoteApiKeyCredential(env);
  const createdAt = now().toISOString();
  return new Map([
    [`organizations/${fixture.owner_org_id}/sites/${fixture.site_id}/api_keys/${credential.prefix}`, {
      id: credential.prefix,
      name: 'Typeroll permanent E2E',
      key_hash: credential.keyHash,
      created_at: createdAt,
      created_by: 'typeroll-e2e-seed',
      is_test_credential: true,
    }],
    [`api_key_lookup/${credential.prefix}`, {
      id: credential.prefix,
      org_id: fixture.owner_org_id,
      site_id: fixture.site_id,
      key_hash: credential.keyHash,
      is_test_credential: true,
    }],
  ]);
}

function readJsonDocuments(root, relative, output) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) readJsonDocuments(root, child, output);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      output.set(child.slice(0, -'.json'.length).split(path.sep).join('/'), JSON.parse(fs.readFileSync(path.join(root, child), 'utf8')));
    }
  }
}

export function fixtureSiteDocuments(manifest, fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  const sourcePrefix = 'organizations/default/sites/default';
  const source = new Map();
  const sourceSiteDoc = path.join(fixtureRoot, `${sourcePrefix}.json`);
  if (!fs.existsSync(sourceSiteDoc)) throw new Error(`Core fixture site is missing at ${sourceSiteDoc}`);
  source.set(sourcePrefix, JSON.parse(fs.readFileSync(sourceSiteDoc, 'utf8')));
  readJsonDocuments(fixtureRoot, sourcePrefix, source);
  const targetPrefix = `organizations/${manifest.core_fixture.owner_org_id}/sites/${manifest.core_fixture.site_id}`;
  return new Map([...source].map(([documentPath, data]) => [
    `${targetPrefix}${documentPath.slice(sourcePrefix.length)}`,
    documentPath === sourcePrefix ? { ...data, name: 'Typeroll E2E Core Site' } : data,
  ]));
}

function fixtureDocumentPath(fixtureRoot, documentPath) {
  const absolute = path.resolve(fixtureRoot, `${documentPath}.json`);
  const root = path.resolve(fixtureRoot);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('E2E fixture path escapes its root');
  return absolute;
}

export function seedLocalPersonas({ fixtureRoot, manifest = readPersonaManifest(), now = () => new Date() }) {
  if (!fixtureRoot) throw new Error('A local E2E fixture root is required');
  const credentials = localPersonaCredentials(manifest);
  const documents = new Map([
    ...fixtureSiteDocuments(manifest),
    ...buildCoreIdentityDocuments(manifest, credentials, now),
  ]);
  for (const [documentPath, data] of documents) {
    const output = fixtureDocumentPath(fixtureRoot, documentPath);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`);
  }
  return { personaCount: corePersonas(manifest).length, documentCount: documents.size };
}

export function verifyLocalPersonas({ fixtureRoot, manifest = readPersonaManifest() }) {
  const credentials = localPersonaCredentials(manifest);
  const expected = buildCoreIdentityDocuments(manifest, credentials, () => new Date(0));
  const errors = [];
  for (const [documentPath, document] of expected) {
    const input = fixtureDocumentPath(fixtureRoot, documentPath);
    if (!fs.existsSync(input)) {
      errors.push(`${documentPath}: missing`);
      continue;
    }
    const actual = JSON.parse(fs.readFileSync(input, 'utf8'));
    for (const key of ['role', 'firebase_uid', 'permission', 'owner_org_id', 'shared_with_org_id', 'site_id', 'roles_enforced']) {
      if (key in document && actual[key] !== document[key]) errors.push(`${documentPath}: ${key} differs`);
    }
  }
  const sitePath = `organizations/${manifest.core_fixture.owner_org_id}/sites/${manifest.core_fixture.site_id}`;
  if (!fs.existsSync(fixtureDocumentPath(fixtureRoot, sitePath))) errors.push(`${sitePath}: missing`);
  if (errors.length) throw new Error(`Local E2E persona verification failed:\n${errors.join('\n')}`);
  return { personaCount: corePersonas(manifest).length };
}

export async function seedRemotePersonas({ services, env, manifest = readPersonaManifest(), now = () => new Date() }) {
  const credentials = remotePersonaCredentials(manifest, env);
  for (const persona of corePersonas(manifest)) {
    await services.auth.upsert({
      uid: persona.uid,
      email: credentials[persona.id].email,
      password: credentials[persona.id].password,
      displayName: `E2E ${persona.id}`,
      customClaims: {
        is_test_account: true,
        e2e_persona: persona.id,
        ...(persona.org_id ? { org_id: persona.org_id } : {}),
      },
    });
  }
  const documents = new Map([
    ...fixtureSiteDocuments(manifest),
    ...buildCoreIdentityDocuments(manifest, credentials, now),
    ...buildRemoteApiKeyDocuments(manifest, env, now),
  ]);
  await services.firestore.setDocuments([...documents].map(([documentPath, data]) => ({ path: documentPath, data })));
  return verifyRemotePersonas({ services, env, manifest });
}

export async function verifyRemotePersonas({ services, env, manifest = readPersonaManifest() }) {
  const credentials = remotePersonaCredentials(manifest, env);
  const errors = [];
  for (const persona of corePersonas(manifest)) {
    const user = await services.auth.get(persona.uid);
    if (!user) {
      errors.push(`${persona.id}: Auth user missing`);
      continue;
    }
    if (user.email !== credentials[persona.id].email) errors.push(`${persona.id}: email differs`);
    if (user.customClaims?.e2e_persona !== persona.id || user.customClaims?.is_test_account !== true) {
      errors.push(`${persona.id}: test claims differ`);
    }
    if ((user.customClaims?.org_id ?? null) !== persona.org_id) errors.push(`${persona.id}: org claim differs`);
    try {
      await services.auth.verifyPassword(credentials[persona.id].email, credentials[persona.id].password);
    } catch {
      errors.push(`${persona.id}: password login failed`);
    }
  }
  const identityDocuments = buildCoreIdentityDocuments(manifest, credentials, () => new Date(0));
  for (const [documentPath, expected] of identityDocuments) {
    const actual = await services.firestore.get(documentPath);
    if (!actual) {
      errors.push(`${documentPath}: missing`);
      continue;
    }
    for (const key of ['role', 'firebase_uid', 'permission', 'owner_org_id', 'shared_with_org_id', 'site_id', 'roles_enforced']) {
      if (key in expected && actual[key] !== expected[key]) errors.push(`${documentPath}: ${key} differs`);
    }
  }
  const apiKeyDocuments = buildRemoteApiKeyDocuments(manifest, env, () => new Date(0));
  for (const [documentPath, expected] of apiKeyDocuments) {
    const actual = await services.firestore.get(documentPath);
    if (!actual) {
      errors.push(`${documentPath}: missing`);
      continue;
    }
    for (const key of ['id', 'org_id', 'site_id', 'key_hash', 'is_test_credential']) {
      if (key in expected && actual[key] !== expected[key]) errors.push(`${documentPath}: ${key} differs`);
    }
  }
  const sitePath = `organizations/${manifest.core_fixture.owner_org_id}/sites/${manifest.core_fixture.site_id}`;
  const pagePath = `${sitePath}/versions/main/pages/home`;
  if (!await services.firestore.get(sitePath)) errors.push(`${sitePath}: missing`);
  if (!await services.firestore.get(pagePath)) errors.push(`${pagePath}: missing`);
  if (errors.length) throw new Error(`Remote E2E persona verification failed:\n${errors.join('\n')}`);
  return { projectId: services.projectId, personaCount: corePersonas(manifest).length };
}

export function resolveFirebasePersonaTarget(env) {
  const rawServiceAccount = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (rawServiceAccount) {
    let credentials;
    try {
      credentials = JSON.parse(rawServiceAccount);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT must contain valid JSON');
    }
    if (!credentials?.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT must contain a project_id');
    return { projectId: credentials.project_id, credentialKind: 'service_account', credentials };
  }

  const projectId = env.GOOGLE_CLOUD_PROJECT?.trim() || env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error(
      'Set FIREBASE_SERVICE_ACCOUNT or use Application Default Credentials with GOOGLE_CLOUD_PROJECT',
    );
  }
  return { projectId, credentialKind: 'application_default', credentials: null };
}

export async function createFirebasePersonaServices(env) {
  const target = resolveFirebasePersonaTarget(env);
  const [{ initializeApp, cert, applicationDefault }, { getAuth }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  const credential = target.credentialKind === 'service_account'
    ? cert(target.credentials)
    : applicationDefault();
  const app = initializeApp({ credential, projectId: target.projectId }, `typeroll-e2e-personas-${Date.now()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const firebaseApiKey = env.TYPEROLL_E2E_FIREBASE_API_KEY?.trim();
  if (!firebaseApiKey) throw new Error('TYPEROLL_E2E_FIREBASE_API_KEY is required');
  return {
    projectId: target.projectId,
    auth: {
      upsert: async ({ uid, email, password, displayName, customClaims }) => {
        try {
          await auth.updateUser(uid, { email, password, displayName, emailVerified: true, disabled: false });
        } catch (error) {
          if (error?.code !== 'auth/user-not-found') throw error;
          await auth.createUser({ uid, email, password, displayName, emailVerified: true, disabled: false });
        }
        await auth.setCustomUserClaims(uid, customClaims);
      },
      get: async (uid) => {
        try {
          const user = await auth.getUser(uid);
          return { uid: user.uid, email: user.email, customClaims: user.customClaims };
        } catch (error) {
          if (error?.code === 'auth/user-not-found') return null;
          throw error;
        }
      },
      verifyPassword: async (email, password) => {
        const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(firebaseApiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Firebase password verification returned ${response.status}`);
      },
    },
    firestore: {
      get: async (documentPath) => {
        const snapshot = await db.doc(documentPath).get();
        return snapshot.exists ? snapshot.data() : null;
      },
      setDocuments: async (documents) => {
        for (let index = 0; index < documents.length; index += 400) {
          const batch = db.batch();
          for (const document of documents.slice(index, index + 400)) batch.set(db.doc(document.path), document.data);
          await batch.commit();
        }
      },
    },
  };
}
