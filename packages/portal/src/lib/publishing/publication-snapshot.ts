import { mapPublicationParts } from './parallel';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { digest } from './providers.mjs';
import { ConnectionError } from './connections';

interface SnapshotContext { orgId: string; siteId: string; jobId: string }
export interface SnapshotReference { snapshot_chunks: number; snapshot_digest: string; snapshot_format?: 1 }

const snapshotPath = (args: SnapshotContext, reference?: SnapshotReference) => reference?.snapshot_format === 1
  ? `${paths.deploy(args.orgId, args.siteId, args.jobId)}/snapshot_versions/${reference.snapshot_digest}/chunks`
  : `${paths.deploy(args.orgId, args.siteId, args.jobId)}/snapshot_chunks`;

export async function saveSnapshot(args: SnapshotContext, value: unknown) {
  const serialized = JSON.stringify(value);
  const chunks = Math.ceil(serialized.length / 120_000);
  if (chunks > 250) throw new ConnectionError('The publication is too large. Reduce generated content before publishing.', 413);
  const reference: SnapshotReference = { snapshot_chunks: chunks, snapshot_digest: digest(serialized), snapshot_format: 1 };
  await mapPublicationParts(Array.from({ length: chunks }, (_, i) => i), async i => {
    const path = `${snapshotPath(args, reference)}/${String(i).padStart(4, '0')}`, data = serialized.slice(i * 120_000, (i + 1) * 120_000);
    if (!await getStore().createDocIfMissing(path, { data })) {
      const saved = await getStore().getDoc<{ data: string }>(path);
      if (saved?.data !== data) throw new ConnectionError('Frozen publication changed during preparation. Retry this publication.', 409, 'publication_snapshot_conflict');
    }
  });
  return reference;
}

export async function readSnapshot(args: SnapshotContext, publication: SnapshotReference) {
  if (!/^[a-f0-9]{64}$/.test(publication.snapshot_digest) || (publication.snapshot_format !== undefined && publication.snapshot_format !== 1)) throw new ConnectionError('Invalid frozen publication identity', 409, 'publication_snapshot_invalid');
  if (!Number.isSafeInteger(publication.snapshot_chunks) || publication.snapshot_chunks < 1 || publication.snapshot_chunks > 250) throw new ConnectionError('Invalid frozen publication size', 409, 'publication_snapshot_invalid');
  const parts = await mapPublicationParts(Array.from({ length: publication.snapshot_chunks }, (_, i) => i), async i => {
    const chunk = await getStore().getDoc<{ data: string }>(`${snapshotPath(args, publication)}/${String(i).padStart(4, '0')}`);
    if (!chunk) throw new ConnectionError('Frozen publication is incomplete', 409, 'publication_snapshot_incomplete');
    return chunk.data;
  });
  const serialized = parts.join('');
  if (digest(serialized) !== publication.snapshot_digest) throw new ConnectionError('Frozen publication failed integrity verification', 409, 'publication_snapshot_integrity');
  return JSON.parse(serialized);
}
