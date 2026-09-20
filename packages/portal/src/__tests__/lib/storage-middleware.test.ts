import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../../lib/load-env', () => ({}));
vi.mock('../../lib/data-schema', () => ({ requireCurrentDataSchema: vi.fn() }));
import { onRequest } from '../../middleware';
import { StorageDocumentError } from '../../lib/firestore-codec';
beforeEach(() => { vi.stubEnv('DEPLOY_QUEUE', 'cloud_tasks'); vi.stubEnv('SERVICE_ROLE', 'portal'); });
it('returns actionable JSON for storage validation while preserving unexpected errors', async () => {
  for (const pathname of ['/api/sites/site/pages/page', '/api/v1/sites/site/pages/page']) {
    const url = new URL(pathname, 'https://cms.example.test');
    const context = { url, request: new Request(url), cookies: { get: () => undefined }, locals: {} };
    const response = await onRequest(context as never, (async () => { throw new StorageDocumentError('storage_document_too_deep', 'Reduce nesting.', 'blocks.0.children'); }) as never) as Response;
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Reduce nesting.', code: 'storage_document_too_deep', field: 'blocks.0.children' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(onRequest(context as never, (async () => { throw new Error('unexpected'); }) as never)).rejects.toThrow('unexpected');
  }
});
