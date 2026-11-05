// Whether a person's account still allows credentials delegated to it
// (personal MCP/OAuth connections, owner-approved organization keys).
// Same rule as portal sessions: a disabled account, an unconfirmed email
// address, or credentials revoked after the grant end access on the next
// request. Without accounts (development, E2E) there is nothing to check.

import { getStore } from '../datastore';
import { isIdentityConfigured, PORTAL_AUTH_PREFIX } from './portal-auth';

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface AccountRow { disabled?: boolean; emailVerified?: boolean; credentialsValidAfter?: string | null }

export async function accountAllowsDelegatedAccess(userId: string, grantedAtMs: number): Promise<boolean> {
  if (!isIdentityConfigured()) return true;
  if (!USER_ID.test(userId) || !Number.isFinite(grantedAtMs)) return false;
  try {
    const user = await getStore().getDoc<AccountRow>(`${PORTAL_AUTH_PREFIX}_user/${userId}`);
    if (!user || user.disabled || user.emailVerified !== true) return false;
    const validAfter = user.credentialsValidAfter ? Date.parse(user.credentialsValidAfter) : NaN;
    return !(Number.isFinite(validAfter) && validAfter > grantedAtMs);
  } catch {
    return false;
  }
}
