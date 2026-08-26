import type { APIRoute } from 'astro';
import { paths, type ExtensionCatalogEntry } from '@typeroll/shared';
import { json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';

export const GET: APIRoute = async ({ url }) => {
  // This endpoint deliberately reads the instance-local catalog only. A
  // self-hosted portal has no network dependency unless its operator imports
  // entries or configures a registry provider explicitly.
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 120);
  const entries = (await getStore().listDocs<ExtensionCatalogEntry>(paths.extensionCatalog()))
    .filter((entry) => entry.status === 'published')
    .filter((entry) => !query || `${entry.name} ${entry.developer_name} ${entry.description ?? ''}`.toLowerCase().includes(query))
    .map(({ reviewed_by: _reviewedBy, review_note: _reviewNote, ...entry }) => entry)
    .sort((a, b) => a.name.localeCompare(b.name));
  return json({ extensions: entries });
};
