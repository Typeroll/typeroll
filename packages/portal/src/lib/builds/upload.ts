import { validateDirectReceipt, type DirectReceipt } from './direct-upload.mjs';
import { findPublicationDeployment, type ProviderClient } from '../publishing/providers.mjs';

/** Finalize the official asset manifest; the coordinator never receives the site binary. */
export async function finalizeDirectUpload(client: ProviderClient, target: { account: string; project: string; branch: string; commit: string }, receipt: DirectReceipt) {
  validateDirectReceipt(receipt);
  const root = `/accounts/${target.account}/pages/projects/${target.project}`;
  const existing = await findPublicationDeployment(client, root, { ...target, ignoreSkipped: true });
  if (existing) return existing;
  const body = new FormData();
  body.set('manifest', JSON.stringify(receipt.manifest)); body.set('branch', target.branch);
  body.set('commit_hash', target.commit); body.set('commit_dirty', 'false');
  for (const [name, value] of Object.entries(receipt.controls)) body.set(name, new File([new Uint8Array(Buffer.from(value, 'base64'))], name));
  return client(`${root}/deployments`, { method: 'POST', body });
}
