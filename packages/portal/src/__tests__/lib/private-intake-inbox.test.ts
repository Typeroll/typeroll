import { beforeEach, expect, it, vi } from 'vitest';
const { list, read } = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ listDocs: list, getDoc: read }) }));
import { listFormSubmissions, readFormSubmission } from '../../lib/form-submissions';
const privateResponse = { id: 'research', form_id: 'survey', data: { interest: false }, status: 'complete', intake: { reference: { page_id: 'company' } } };
beforeEach(() => {
  vi.clearAllMocks();
  list.mockImplementation(async (path: string) => path.endsWith('/submissions') ? [privateResponse, { id: 'ordinary', form_id: 'survey', data: { message: 'Hello' } }] : []);
  read.mockResolvedValue(privateResponse);
});
it('hides private interviews from ordinary inbox readers and broad installation submission scopes', async () => {
  expect((await listFormSubmissions('o', 's', 'survey', { isAdmin: false })).submissions.map(row => row.id)).toEqual(['ordinary']);
  expect(await readFormSubmission('o', 's', 'survey', 'research', false)).toBeNull();
});
it('allows site administrators to inspect the private record through the inbox', async () => {
  expect((await listFormSubmissions('o', 's', 'survey', { isAdmin: true })).submissions).toHaveLength(2);
  expect(await readFormSubmission('o', 's', 'survey', 'research', true)).toMatchObject({ data: { interest: false } });
});
