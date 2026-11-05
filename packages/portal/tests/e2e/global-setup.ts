// Seeds the local E2E Worker's empty store with the fixture content.
// Playwright starts `webServer` before global setup, so the Worker is up.
import { resolveE2ETarget } from '../../../../scripts/lib/e2e-target.mjs';
import { seedLocalStore } from './seed-store.mjs';

export default async function globalSetup(): Promise<void> {
  const target = resolveE2ETarget(process.env);
  if (target.isRemote) return;
  const { written } = await seedLocalStore({ portalUrl: target.portalUrl, secret: process.env.TYPEROLL_E2E_AUTH_SECRET });
  console.log(`[e2e-seed] wrote ${written} fixture documents to ${target.portalUrl}`);
}
