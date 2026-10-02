// "Check again" for the GitHub connection, without a new sign-in.
//
// Installations, suspension, repository access, permissions and organization
// roles are read with the publisher App's own authority. The person's GitHub
// identity is the one OAuth proved for this Typeroll user within the last
// hour; it is never taken from the request. A re-check consumes no grant and
// connects nothing: a usable organization becomes a choice the person must
// confirm, and selecting it re-verifies ownership again before saving.
// Personal accounts still need a sign-in, because publishing to them needs
// the person's own authorization.
//
// Only accounts GitHub showed the person at sign-in, their own account and
// accounts they prove they own are explained in detail. An organization the
// person names gets the same answer whether or not the App is installed there.

import { ConnectionError, getConnection, type Connection } from './connections';
import { githubConfiguration } from './github-config';
import {
  evaluateInstallations, installationConfigurationBlockers, pendingGithubInstallation, storeGithubSelection, type GithubChoice,
} from './github-connection';
import {
  blockerFromError, composeDiagnosis, connectPersonalAction, currentGithubDiagnosis, githubBlocker, githubDiagnosisSequence, organizationView, publicDiagnosis,
  recordGithubDiagnosis, storedGithubDiagnosis, trustedGithubIdentity,
  type GithubBlocker, type GithubCheckedAccount, type GithubConnectionDiagnosis, type GithubDiagnosisInstallation, type GithubIdentity,
  type StoredDiagnosis,
} from './github-diagnosis';
import { createProviderClient, githubAppClient, type ProviderClient } from './providers.mjs';

const THROTTLE_MS = 5_000;
/** GitHub returns to the Setup URL within seconds of an installation; after this long without a callback it is likely missing. */
export const SETUP_RETURN_GRACE_MS = 2 * 60 * 1000;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

export interface GithubRecheckActor { orgId: string; userId: string }

/**
 * Re-run the checks and persist the result. Concurrent or repeated calls
 * within five seconds for an organization return the current diagnosis.
 * `person` is false for API keys: they may re-check a connected account but
 * cannot use a person's GitHub identity or create choices, and they receive
 * only the organization-level view.
 *
 * The result of a check is returned even when a concurrent result was
 * recorded first; it is never replaced by a stored or synthesized one.
 */
export async function recheckGithubDiagnosis(actor: GithubRecheckActor, options: { owner?: string; person: boolean },
  fetchImpl: typeof fetch = fetch): Promise<GithubConnectionDiagnosis> {
  if (options.owner !== undefined && (typeof options.owner !== 'string' || (options.owner && !LOGIN.test(options.owner)))) {
    throw new ConnectionError('Use the GitHub organization’s address name, such as example-org.', 400);
  }
  const viewer = options.person ? { userId: actor.userId } : undefined;
  const stored = await storedGithubDiagnosis(actor.orgId);
  const now = Date.now();
  if (stored?.rechecked_at && now - stored.rechecked_at < THROTTLE_MS) return currentGithubDiagnosis(actor.orgId, viewer);
  // Readers hide a diagnosis after 24 hours, but the document keeps its sequence.
  const sequence = await githubDiagnosisSequence(actor.orgId);
  const connection = await getConnection(actor.orgId, 'github');
  let config: ReturnType<typeof githubConfiguration>;
  try { config = githubConfiguration(); }
  catch { return currentGithubDiagnosis(actor.orgId, viewer); }
  if (connection.status === 'connected' && connection.github) {
    const diagnosis = await checkConnected(actor, connection, config, fetchImpl);
    await recordGithubDiagnosis(actor.orgId, diagnosis, { userId: actor.userId, scope: 'connection', recheckedAt: now, expectedSequence: sequence });
    return options.person ? publicDiagnosis(diagnosis) : organizationView(diagnosis);
  }
  if (!options.person) return currentGithubDiagnosis(actor.orgId);
  const user = trustedGithubIdentity(stored, actor.userId, now);
  if (!user) {
    // Without a sign-in within the hour the person's role cannot be checked. Keep the explanation and ask for a sign-in.
    const current = await currentGithubDiagnosis(actor.orgId, viewer);
    const next = { ...current, checked_at: new Date(now).toISOString(), primary_action: { kind: 'sign_in', label: 'Sign in to GitHub to check again' } } satisfies GithubConnectionDiagnosis;
    if (stored?.user_id === actor.userId && stored.revision === connection.revision) {
      await recordGithubDiagnosis(actor.orgId, next, { userId: actor.userId, recheckedAt: now, expectedSequence: sequence });
    }
    return next;
  }
  const identity: GithubIdentity = { user, verifiedAt: stored!.identity_verified_at!, accounts: stored!.accounts ?? [] };
  const result = await checkIdentity(actor, connection, config, identity, stored!, options.owner ?? '', fetchImpl);
  await recordGithubDiagnosis(actor.orgId, result.diagnosis, { userId: actor.userId, recheckedAt: now, expectedSequence: sequence,
    identity: { ...identity, accounts: result.accounts }, selectionExpiresAt: result.selectionExpiresAt });
  return publicDiagnosis(result.diagnosis);
}

/** The saved installation, read with App authority. */
async function checkConnected(actor: GithubRecheckActor, connection: Connection, config: ReturnType<typeof githubConfiguration>, fetchImpl: typeof fetch) {
  const saved = connection.github!;
  const account = { login: saved.owner, type: saved.account_type ?? 'Organization', id: saved.account_id } as const;
  const context = { account, installationId: saved.installation_id, owner: true, retry: 'recheck' as const };
  const app = githubAppClient(config, fetchImpl);
  const row: GithubDiagnosisInstallation = { installation_id: saved.installation_id, account, usable: true, blockers: [] };
  const blockers: GithubBlocker[] = [];
  try {
    if (saved.app_id !== config.appId) throw new ConnectionError('The GitHub publisher configuration changed.', 503, 'publisher_app_misconfigured');
    const installation = await app(`/app/installations/${encodeURIComponent(saved.installation_id)}`, { missing: true });
    if (!installation) blockers.push(githubBlocker('no_installation'));
    else if (String(installation.account?.id) !== saved.account_id) blockers.push(githubBlocker('revision_conflict', { retry: 'recheck' }));
    else row.blockers.push(...await installationConfigurationBlockers(installation, context, async () => (await app('/app'))?.permissions ?? null));
  } catch (error) {
    blockers.push((error as { status?: number }).status === 401 ? githubBlocker('publisher_app_misconfigured', { detail: 'GitHub rejected the App credentials' }) : blockerFromError(error, context));
  }
  row.usable = !row.blockers.length && !blockers.length;
  return composeDiagnosis({ revision: connection.revision, attemptedBy: actor.userId, connected: true, scope: 'connection', blockers, installations: [row] });
}

/**
 * Installations of the person's own account, the accounts GitHub showed them at sign-in, accounts they
 * proved they own, and an optional named organization.
 */
async function checkIdentity(actor: GithubRecheckActor, connection: Connection, config: ReturnType<typeof githubConfiguration>,
  identity: GithubIdentity, stored: StoredDiagnosis, owner: string, fetchImpl: typeof fetch) {
  const { user } = identity;
  const app = githubAppClient(config, fetchImpl);
  const self = user.login.toLowerCase(), named = owner.toLowerCase();
  const known = new Map<string, GithubCheckedAccount>((identity.accounts ?? []).map(account => [account.login.toLowerCase(), account]));
  const visible = (login: string) => login === self || known.has(login);
  const candidates = new Map<string, 'User' | 'Organization'>([[self, 'User']]);
  for (const [login, account] of known) candidates.set(login, account.type);
  if (named && !candidates.has(named)) candidates.set(named, 'Organization');
  const found: any[] = [];
  const blockers: GithubBlocker[] = [];
  const failures: GithubDiagnosisInstallation[] = [];
  let namedLookedUp = false;
  for (const [login, type] of candidates) {
    try {
      const installation = await app(`/${type === 'User' ? 'users' : 'orgs'}/${encodeURIComponent(login)}/installation`, { missing: true });
      if (installation) found.push(installation);
      if (login === named) namedLookedUp = true;
    } catch (error) {
      const row = visible(login) ? stored.installations.find(item => item.account.login.toLowerCase() === login) : undefined;
      const blocker = blockerFromError(error, { account: row?.account, installationId: row?.installation_id, retry: 'recheck' });
      if (row) failures.push({ ...row, usable: false, blockers: [blocker] });
      else blockers.push(blocker);
    }
  }
  const tokens = new Map<string, Promise<ProviderClient>>();
  const installationClient = (id: string) => {
    if (!tokens.has(id)) tokens.set(id, app(`/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: 'POST', body: {} })
      .then(access => createProviderClient('GitHub', access.token, fetchImpl)));
    return tokens.get(id)!;
  };
  const evaluation = await evaluateInstallations({
    orgId: actor.orgId, appId: config.appId, user, current: connection, installations: found, personalGrant: 'sign_in_required', retry: 'recheck',
    // Installation tokens are not subject to the person's SSO session and need the App's Members permission.
    membership: async installation => (await installationClient(String(installation.id)))(
      `/orgs/${encodeURIComponent(installation.account.login)}/memberships/${encodeURIComponent(user.login)}`, { missing: true }),
    appPermissions: async () => (await app('/app'))?.permissions ?? null,
  });
  // A named account is explained only when the person proves they own it. Otherwise it gets one answer,
  // whether or not the App is installed there, so the check reveals nothing about another organization.
  const accounts = [...known.values()];
  const evaluated = evaluation.installations.filter(row => {
    const login = row.account.login.toLowerCase();
    if (visible(login)) return true;
    if (!evaluation.owned.includes(row.installation_id)) return false;
    accounts.push({ login: row.account.login, type: row.account.type, origin: 'owned' });
    return true;
  });
  const installations = [...evaluated, ...failures.filter(item => !evaluated.some(row => row.installation_id === item.installation_id))];
  const lookupFailed = blockers.length > 0;
  if (namedLookedUp && !visible(named) && !evaluated.some(row => row.account.login.toLowerCase() === named)) {
    blockers.push(githubBlocker('not_org_owner', { account: { login: owner, type: 'Organization', id: '' }, user, unverified: true }));
  }
  if (!evaluation.ownsAny && !lookupFailed) blockers.push(githubBlocker('no_installation'));
  // The person installed the App on an account they own, but GitHub never returned to the callback for the
  // installation they started here: the publisher's App probably has no Setup URL. The person can still continue.
  const installStartedAt = evaluation.ownsAny ? await pendingGithubInstallation(actor) : null;
  if (installStartedAt !== null && Date.now() - installStartedAt >= SETUP_RETURN_GRACE_MS) blockers.push(githubBlocker('setup_url_missing'));
  const shown = new Set(evaluated.map(row => row.installation_id));
  const choices = evaluation.choices.filter(choice => shown.has(choice.installation_id));
  const organizations = choices.filter(choice => choice.account_type !== 'User');
  const personal = choices.find(choice => choice.account_type === 'User' && !choice.account_change);
  const selectionExpiresAt = organizations.length ? await storeGithubSelection(actor, identity, connection.revision, organizations as GithubChoice[]) : null;
  const diagnosis = composeDiagnosis({ revision: connection.revision, attemptedBy: actor.userId, githubUser: user, blockers, installations,
    choose: organizations.length > 1 || (organizations.length === 1 && !organizations[0].account_change) });
  if (!organizations.length && personal && diagnosis.outcome === 'action_required') {
    // The personal account is ready on GitHub; connecting it needs the person's own authorization, confirmed once on GitHub.
    diagnosis.primary_action = connectPersonalAction(personal.owner, true);
  }
  return { diagnosis, accounts, selectionExpiresAt };
}
