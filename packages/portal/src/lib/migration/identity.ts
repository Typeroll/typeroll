// The identity half of the import: `firebase auth:export --format=json` into
// Better Auth over the target store. UIDs are kept, so memberships and API-key
// ownership in the imported documents need no rewrite.

import { importFirebaseUsers, type FirebaseExportUser, type FirebaseImportReport } from '../identity/firebase-import';
import type { PortalAuth } from '../identity/portal-auth';

export interface IdentityImportReport extends FirebaseImportReport { users: number }

/** Parse a `firebase auth:export` JSON file (`{"users": [...]}`) and import it. */
export async function importIdentityExport(auth: PortalAuth, text: string): Promise<IdentityImportReport> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('The identity export is not JSON'); }
  const users = (parsed as { users?: unknown })?.users;
  if (!Array.isArray(users)) throw new Error('The identity export has no "users" array');
  return { users: users.length, ...await importFirebaseUsers(auth, users as FirebaseExportUser[]) };
}
