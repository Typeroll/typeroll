import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { publishTree, ProviderError } from '../../lib/publishing/providers.mjs';

// AT-18: GitHub answered 422 validation_failed for a tree that reused blobs; a retry passed.
const blob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
function fakeGithub(failures: number) {
  const trees: any[] = [];
  const github = vi.fn(async (route: string, options: any = {}) => {
    if (route.endsWith('/git/ref/heads/main')) return { object: { sha: 'parent' } };
    if (route.endsWith('/git/commits/parent')) return { tree: { sha: 'old-tree' } };
    if (route.includes('/git/trees/old-tree')) return { truncated: false, tree: [{ path: 'same.txt', mode: '100644', type: 'blob', sha: blob('same') }] };
    if (route.endsWith('/git/trees') && options.method === 'POST') {
      trees.push(options.body.tree);
      if (trees.length <= failures) throw new ProviderError('GitHub', 422, [], { reason: 'validation_failed', operation: 'POST /repos/:id/:id/git/trees' });
      return { sha: 'new-tree' };
    }
    if (route.endsWith('/git/commits') && options.method === 'POST') return { sha: 'new-commit' };
    if (route.endsWith('/git/refs/heads/main')) return {};
    throw new Error(`unexpected ${route}`);
  });
  return { github, trees };
}
const input = { owner: 'synthetic', repo: 'site', files: { 'same.txt': 'same', 'new.txt': 'new' }, message: 'Publish', retryDelays: [0, 0] };

it('retries a 422 tree creation and finally sends every file as content', async () => {
  const { github, trees } = fakeGithub(2);
  expect(await publishTree(github as any, input)).toEqual({ commit: 'new-commit', changed: true, branch: 'main' });
  expect(trees).toHaveLength(3);
  expect(trees[0].find((entry: any) => entry.path === 'same.txt')).toMatchObject({ sha: blob('same') });
  expect(trees[2].every((entry: any) => 'content' in entry && !('sha' in entry))).toBe(true);
  // The ref is updated once and never forced.
  expect(github.mock.calls.filter(([route, options]) => route.endsWith('/git/refs/heads/main') && options?.method === 'PATCH')).toEqual([[expect.any(String), { method: 'PATCH', body: { sha: 'new-commit', force: false } }]]);
});

it('stops after the bounded retries and keeps the provider error for the job', async () => {
  const { github, trees } = fakeGithub(5);
  await expect(publishTree(github as any, input)).rejects.toMatchObject({ status: 422, reason: 'validation_failed' });
  expect(trees).toHaveLength(3);
});

it('does not retry other refusals', async () => {
  const github = vi.fn(async (route: string, options: any = {}) => {
    if (route.endsWith('/git/ref/heads/main')) return { object: { sha: 'parent' } };
    if (route.endsWith('/git/commits/parent')) return { tree: { sha: 'old-tree' } };
    if (route.includes('/git/trees/old-tree')) return { truncated: false, tree: [] };
    if (route.endsWith('/git/trees') && options.method === 'POST') throw new ProviderError('GitHub', 403, []);
    throw new Error(`unexpected ${route}`);
  });
  await expect(publishTree(github as any, input)).rejects.toMatchObject({ status: 403 });
  expect(github.mock.calls.filter(([route]) => route.endsWith('/git/trees'))).toHaveLength(1);
});
