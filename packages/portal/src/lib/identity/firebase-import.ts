// One-time import of `firebase auth:export --format=json` into Better Auth.
//
// - The Firebase UID stays the user id, so memberships (`firebase_uid`),
//   API-key ownership and audit fields keep pointing at the same person.
// - A password user gets a `credential` account holding `fbscrypt$salt$hash`;
//   portal-auth verifies it with LEGACY_FIREBASE_SCRYPT and rehashes it on the
//   first successful sign-in.
// - A GitHub user gets a `github` account keyed by the GitHub user id.
// - Disabled Firebase users stay disabled. Users without an email address are
//   reported and skipped: every portal identity is email-based.
//
// Idempotent: users and accounts that already exist are left untouched, so a
// rerun after a partial failure completes the import without duplicates.

import type { PortalAuth } from './portal-auth';
import { formatFirebaseScryptHash } from './firebase-scrypt';

export interface FirebaseExportUser {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoUrl?: string;
  passwordHash?: string;
  salt?: string;
  disabled?: boolean;
  createdAt?: string;
  providerUserInfo?: Array<{ providerId: string; rawId: string; email?: string }>;
}

export interface FirebaseImportReport {
  created: number;
  existing: number;
  accountsCreated: number;
  skipped: Array<{ uid: string; reason: string }>;
}

const UID = /^[A-Za-z0-9_-]{1,128}$/;

export async function importFirebaseUsers(auth: PortalAuth, users: FirebaseExportUser[]): Promise<FirebaseImportReport> {
  const context = await auth.$context;
  const adapter = context.adapter;
  const report: FirebaseImportReport = { created: 0, existing: 0, accountsCreated: 0, skipped: [] };

  for (const user of users) {
    const email = user.email?.trim().toLowerCase();
    if (!UID.test(user.localId ?? '')) { report.skipped.push({ uid: String(user.localId), reason: 'invalid uid' }); continue; }
    if (!email) { report.skipped.push({ uid: user.localId, reason: 'no email address' }); continue; }

    const existing = await context.internalAdapter.findUserById(user.localId);
    if (existing) {
      if (existing.email !== email) { report.skipped.push({ uid: user.localId, reason: 'id exists with another email' }); continue; }
      report.existing++;
    } else {
      const byEmail = await context.internalAdapter.findUserByEmail(email);
      if (byEmail) { report.skipped.push({ uid: user.localId, reason: 'email belongs to another user' }); continue; }
      const createdAt = user.createdAt && /^\d+$/.test(user.createdAt) ? new Date(Number(user.createdAt)) : new Date();
      await adapter.create({
        model: 'user',
        forceAllowId: true,
        data: {
          id: user.localId,
          email,
          name: user.displayName?.trim() || email.split('@')[0]!,
          emailVerified: user.emailVerified === true,
          image: user.photoUrl ?? null,
          disabled: user.disabled === true,
          createdAt,
          updatedAt: new Date(),
        },
      });
      report.created++;
    }

    const accounts = await context.internalAdapter.findAccounts(user.localId);
    if (user.passwordHash && user.salt && !accounts.some(account => account.providerId === 'credential')) {
      await context.internalAdapter.linkAccount({
        userId: user.localId,
        providerId: 'credential',
        accountId: user.localId,
        password: formatFirebaseScryptHash(user.salt, user.passwordHash),
      });
      report.accountsCreated++;
    }
    for (const provider of user.providerUserInfo ?? []) {
      if (provider.providerId !== 'github.com' || !provider.rawId) continue;
      if (accounts.some(account => account.providerId === 'github' && account.accountId === provider.rawId)) continue;
      await context.internalAdapter.linkAccount({ userId: user.localId, providerId: 'github', accountId: provider.rawId });
      report.accountsCreated++;
    }
  }
  return report;
}
