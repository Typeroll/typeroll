import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { digest } from './providers.mjs';
import { ConnectionError } from './connections';

interface SnapshotContext { orgId: string; siteId: string; jobId: string }
export interface SnapshotReference { snapshot_chunks: number; snapshot_digest: string }

const snapshotPath = (args: SnapshotContext) => `${paths.deploy(args.orgId, args.siteId, args.jobId)}/snapshot_chunks`;

export async function saveSnapshot(args: SnapshotContext, value: unknown) {
  const serialized = JSON.stringify(value);
  const chunks = Math.ceil(serialized.length / 120_000);
  if (chunks > 250) throw new ConnectionError('The publication is too large. Reduce generated content before publishing.', 413);
  for (let i = 0; i < chunks; i++) await getStore().setDoc(`${snapshotPath(args)}/${String(i).padStart(4, '0')}`, { data: serialized.slice(i * 120_000, (i + 1) * 120_000) });
  return { snapshot_chunks: chunks, snapshot_digest: digest(serialized) };
}

export async function readSnapshot(args: SnapshotContext, publication: SnapshotReference) {
  if (!Number.isSafeInteger(publication.snapshot_chunks) || publication.snapshot_chunks < 1 || publication.snapshot_chunks > 250) throw new Error('Invalid frozen publication size');
  let serialized = '';
  for (let i = 0; i < publication.snapshot_chunks; i++) {
    const chunk = await getStore().getDoc<{ data: string }>(`${snapshotPath(args)}/${String(i).padStart(4, '0')}`);
    if (!chunk) throw new Error('Frozen publication is incomplete');
    serialized += chunk.data;
  }
  if (digest(serialized) !== publication.snapshot_digest) throw new Error('Frozen publication failed integrity verification');
  return JSON.parse(serialized);
}
