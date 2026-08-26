// Firebase client SDK initialization. Used by the React components for auth
// and (eventually) real-time content updates. Configuration is injected via
// PUBLIC_* env vars so it ends up in the client bundle.

import { initializeApp, getApps } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const config = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);

let _auth: Auth | null = null;

export function getFirebaseAuth(): Auth | null {
  if (!firebaseConfigured) return null;
  if (_auth) return _auth;
  const app = getApps()[0] ?? initializeApp(config);
  _auth = getAuth(app);
  return _auth;
}
