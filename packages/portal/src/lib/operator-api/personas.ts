// Idempotent seeding of the permanent E2E personas on a staging portal.
//
// Disabled unless the portal Worker sets TYPEROLL_E2E_PERSONA_SEEDING=allow,
// which only staging does. Even then it touches nothing outside the E2E
// namespace: user ids `typeroll-e2e-*`, organizations `e2e-*`, their share
// and membership indexes, and API-key lookups marked `is_test_credential`.
// Passwords are hashed by the portal's Better Auth instance.

import { storeBackend } from '../datastore';
import { INSTALLATION_PATH } from '../data-schema';
import type { ReadWriteStore } from '../datastore';
import { PORTAL_AUTH_PREFIX, type PortalAuth } from '../identity/portal-auth';
import {
  OperatorApiError,
  type ApiDocument, type DocumentData, type PersonaInspectRequest, type PersonaInspection, type PersonaSeedRequest, type PersonaState,
} from './contract';
import { body } from './documents';

const UID = /^typeroll-e2e-[a-z][a-z0-9_-]{0,60}$/;
const PERSONA = /^[a-z][a-z0-9_]{0,40}$/;
const ORG = 'e2e-[a-z0-9-]{1,60}';
// Fixture content includes markers such as `_migrations/unified-pages`.
const S = '[A-Za-z0-9_][A-Za-z0-9_.%-]{0,255}';
const NAMESPACE = [
  new RegExp(`^organizations/${ORG}(?:/${S}/${S})*$`),
  new RegExp(`^org_share_index/${ORG}/shares/${S}$`),
  new RegExp(`^user_organizations/typeroll-e2e-[a-z][a-z0-9_-]{0,60}(?:/organizations/${ORG})?$`),
];
const API_KEY_LOOKUP = /^api_key_lookup\/[0-9a-f]{12}$/;
const MAX_DOCUMENTS = 500;

export interface PersonaDeps {
  store: () => ReadWriteStore;
  auth: () => PortalAuth | null;
  env: Record<string, string | undefined>;
  now: () => Date;
}

export class OperatorPersonas {
  constructor(private readonly deps: PersonaDeps) {}

  private context() {
    if (this.deps.env.TYPEROLL_E2E_PERSONA_SEEDING !== 'allow') throw new OperatorApiError('not_enabled', 'E2E persona seeding is not enabled on this portal');
    const auth = this.deps.auth();
    if (!auth) throw new OperatorApiError('not_enabled', 'portal sign-in is not configured');
    return auth.$context;
  }

  async seedE2EPersonas(request: PersonaSeedRequest): Promise<PersonaInspection> {
    const context = await this.context();
    // Seeding an object store without its installation record would leave
    // data the schema check can never adopt (every request then answers 503).
    if (storeBackend() === 'durable_object' && !await this.deps.store().getDoc(INSTALLATION_PATH)) {
      throw new OperatorApiError('not_enabled', 'the store has no installation record yet; import or bootstrap it before seeding personas');
    }
    if (!request || !Array.isArray(request.personas) || !Array.isArray(request.documents) || request.documents.length > MAX_DOCUMENTS) {
      throw new OperatorApiError('invalid_request', 'personas and documents are required');
    }
    for (const persona of request.personas) validatePersona(persona, true);
    for (const document of request.documents) {
      if (!document || typeof document.data !== 'object' || document.data === null || Array.isArray(document.data)) {
        throw new OperatorApiError('invalid_request', 'every document needs data');
      }
      if (document.preserve !== undefined && (!Array.isArray(document.preserve) || document.preserve.some(field => typeof field !== 'string'))) {
        throw new OperatorApiError('invalid_request', 'preserve lists field names');
      }
      await this.assertNamespace(document.path, document.data);
    }

    const store = this.deps.store();
    for (const persona of request.personas) {
      const email = persona.email.trim().toLowerCase();
      const name = persona.name.trim();
      const now = this.deps.now();
      try {
        if (await context.internalAdapter.findUserById(persona.uid)) {
          await context.internalAdapter.updateUser(persona.uid, { email, name, emailVerified: true, disabled: false });
        } else {
          await context.adapter.create({
            model: 'user', forceAllowId: true,
            data: { id: persona.uid, email, name, emailVerified: true, disabled: false, createdAt: now, updatedAt: now },
          });
        }
      } catch (error) {
        if ((error as Error)?.name === 'UniqueConstraintError') throw new OperatorApiError('conflict', `${persona.persona}: the email address belongs to another account`);
        throw error;
      }
      await this.markTestAccount(persona.uid, persona.persona);
      const credential = (await context.internalAdapter.findAccounts(persona.uid)).find(account => account.providerId === 'credential');
      if (!credential) {
        await context.internalAdapter.linkAccount({ userId: persona.uid, providerId: 'credential', accountId: persona.uid, password: await context.password.hash(persona.password) });
      } else if (!credential.password || !await context.password.verify({ hash: credential.password, password: persona.password })) {
        await context.internalAdapter.updatePassword(persona.uid, await context.password.hash(persona.password));
      }
    }

    for (const document of request.documents) {
      let data = body(document.data);
      if (document.preserve?.length) {
        const existing = await store.getDoc<DocumentData>(document.path);
        for (const field of document.preserve) if (existing && existing[field] !== undefined) data = { ...data, [field]: existing[field] };
      }
      await store.setDoc(document.path, data);
    }

    return this.inspectE2EPersonas({
      personas: request.personas.map(({ persona, uid, email, password }) => ({ persona, uid, email, password })),
      paths: request.documents.map(document => document.path),
    });
  }

  async inspectE2EPersonas(request: PersonaInspectRequest): Promise<PersonaInspection> {
    const context = await this.context();
    if (!request || !Array.isArray(request.personas) || !Array.isArray(request.paths) || request.paths.length > MAX_DOCUMENTS) {
      throw new OperatorApiError('invalid_request', 'personas and paths are required');
    }
    for (const persona of request.personas) validatePersona(persona, false);
    for (const path of request.paths) await this.assertNamespace(path, null);

    const personas: PersonaState[] = [];
    for (const persona of request.personas) {
      const user = await this.deps.store().getDoc<Record<string, unknown>>(`${PORTAL_AUTH_PREFIX}_user/${persona.uid}`);
      const credential = user ? (await context.internalAdapter.findAccounts(persona.uid)).find(account => account.providerId === 'credential') : undefined;
      personas.push({
        persona: persona.persona,
        uid: persona.uid,
        exists: !!user,
        email: typeof user?.email === 'string' ? user.email : null,
        emailVerified: user?.emailVerified === true,
        disabled: user?.disabled === true,
        testAccount: user?.is_test_account === true && user?.e2e_persona === persona.persona,
        passwordValid: !!credential?.password && await context.password.verify({ hash: credential.password, password: persona.password }),
      });
    }
    const documents: Record<string, ApiDocument | null> = {};
    for (const path of request.paths) documents[path] = await this.deps.store().getDoc<DocumentData>(path) as ApiDocument | null;
    return { personas, documents };
  }

  private async markTestAccount(uid: string, persona: string): Promise<void> {
    const store = this.deps.store(), path = `${PORTAL_AUTH_PREFIX}_user/${uid}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await store.getDoc<DocumentData>(path);
      if (!row) throw new OperatorApiError('not_found', `${uid} disappeared while seeding`);
      if (row.is_test_account === true && row.e2e_persona === persona) return;
      if (await store.compareAndReplaceDoc(path, row, { ...body(row), is_test_account: true, e2e_persona: persona })) return;
    }
    throw new OperatorApiError('conflict', `${uid} is changing too often; retry`);
  }

  /** Writes stay inside the E2E namespace; a key lookup must be (and stay) a test credential. */
  private async assertNamespace(path: unknown, data: DocumentData | null): Promise<void> {
    if (typeof path !== 'string' || path.length > 1024) throw new OperatorApiError('forbidden_path', 'invalid path');
    if (NAMESPACE.some(pattern => pattern.test(path))) return;
    if (API_KEY_LOOKUP.test(path)) {
      const testOrg = (value: unknown) => typeof value === 'string' && new RegExp(`^${ORG}$`).test(value);
      if (data && (data.is_test_credential !== true || !testOrg(data.org_id))) throw new OperatorApiError('forbidden_path', `${path} must describe an E2E test credential`);
      const existing = await this.deps.store().getDoc<DocumentData>(path);
      if (existing && (existing.is_test_credential !== true || !testOrg(existing.org_id))) throw new OperatorApiError('forbidden_path', `${path} belongs to a real credential`);
      return;
    }
    throw new OperatorApiError('forbidden_path', `${path.slice(0, 200)} is outside the E2E namespace`);
  }
}

function validatePersona(persona: unknown, seeding: boolean): void {
  const p = persona as Record<string, unknown> | null;
  const valid = !!p && typeof p.persona === 'string' && PERSONA.test(p.persona) && typeof p.uid === 'string' && UID.test(p.uid)
    && typeof p.email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(p.email.trim())
    && typeof p.password === 'string' && p.password.length >= 32 && p.password.length <= 128
    && (!seeding || (typeof p.name === 'string' && p.name.trim().length > 0 && p.name.trim().length <= 120));
  if (!valid) throw new OperatorApiError('invalid_request', `invalid persona ${typeof p?.persona === 'string' ? p.persona.slice(0, 40) : ''}`);
}
