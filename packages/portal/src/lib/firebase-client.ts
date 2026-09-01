// Firebase client SDK initialization. Used by the React components for auth
// and (eventually) real-time content updates. Configuration is injected into
// the HTML at request time so one immutable portal image can run in every
// Cloud and self-hosted environment.

import { initializeApp, getApps } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { readPublicRuntimeConfig } from './runtime-config';

let _auth: Auth | null = null;

export function getFirebaseAuth(): Auth | null {
  if (_auth) return _auth;
  const config = readPublicRuntimeConfig().firebase;
  if (!config.apiKey || !config.projectId) return null;
  const app = getApps()[0] ?? initializeApp(config);
  _auth = getAuth(app);
  return _auth;
}

/** Test-only: drop the client singleton so a new runtime config is read. */
export function _resetFirebaseAuthForTests(): void {
  _auth = null;
}
