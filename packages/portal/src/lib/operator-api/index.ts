// Entry point of the operator API (see contract.ts for the transport and the
// trust model). Runtime-neutral: nothing here imports `cloudflare:workers`.
// The portal Worker wraps it in a named entrypoint, for example:
//
//   import { WorkerEntrypoint } from 'cloudflare:workers';
//   import { createOperatorApi, type OperatorApiMethods } from './lib/operator-api';
//   export class OperatorApi extends WorkerEntrypoint<Env> implements OperatorApiMethods {
//     #api = createOperatorApi();
//     describe() { return this.#api.describe(); }
//     getDocument(path: string) { return this.#api.getDocument(path); }
//     … one delegating method per name in OPERATOR_API_METHOD_NAMES …
//   }
//
// and only the operator Worker's configuration binds it:
//   services = [{ binding = "CORE_API", service = "<portal script>", entrypoint = "OperatorApi" }]

import { DATA_SCHEMA_VERSION } from '@typeroll/shared';
import { getStore, type ReadWriteStore } from '../datastore';
import { getPortalAuth, type PortalAuth } from '../identity/portal-auth';
import { OPERATOR_API_VERSION, type OperatorApiMethods } from './contract';
import { OperatorDocuments } from './documents';
import { OperatorPeople } from './people';
import { OperatorPersonas } from './personas';

export * from './contract';
export { commitScope, documentAccess } from './paths';

export interface OperatorApiDeps {
  store?: () => ReadWriteStore;
  auth?: () => PortalAuth | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createOperatorApi(deps: OperatorApiDeps = {}): OperatorApiMethods {
  const store = deps.store ?? getStore;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const documents = new OperatorDocuments(store);
  const people = new OperatorPeople(store, now);
  const personas = new OperatorPersonas({ store, now, env, auth: deps.auth ?? (() => getPortalAuth(env)) });
  return {
    describe: async () => ({ api: 'typeroll-operator', version: OPERATOR_API_VERSION, data_schema_version: DATA_SCHEMA_VERSION }),
    getDocument: path => documents.getDocument(path),
    getDocuments: paths => documents.getDocuments(paths),
    listDocuments: (collection, options) => documents.listDocuments(collection, options),
    commit: request => documents.commit(request),
    listPeople: options => people.listPeople(options),
    getPerson: id => people.getPerson(id),
    updatePerson: update => people.updatePerson(update),
    revokePersonCredentials: id => people.revokePersonCredentials(id),
    seedE2EPersonas: request => personas.seedE2EPersonas(request),
    inspectE2EPersonas: request => personas.inspectE2EPersonas(request),
  };
}
