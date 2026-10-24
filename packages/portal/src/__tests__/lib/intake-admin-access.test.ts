import { beforeEach, expect, it, vi } from 'vitest';
const { auth, read, list, dispatch } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), list: vi.fn(), dispatch: vi.fn() }));
vi.mock('../../lib/api-auth', () => ({ requireApiKey: auth, apiError: (error: string, status = 400) => new Response(JSON.stringify({ error }), { status }), apiResponse: (_ctx: unknown, body: unknown) => Response.json(body) }));
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ getDoc: read, listDocs: list }) }));
vi.mock('../../lib/forms/intake-notifications', () => ({ dispatchIntakeNotifications: dispatch, intakeNoticeStatus: () => ({}) }));
import { GET, POST } from '../../pages/api/v1/sites/[siteId]/forms/[formId]/intake-responses';
const base = { orgId: 'o', siteId: 's', permission: 'admin' }, installation = { installationId: 'i', scopes: ['forms:intake:read', 'email:send'] };
const context = (method = 'GET', body?: unknown) => ({ params: { siteId: 's', formId: 'survey' }, request: new Request('https://cms.example.invalid/api/v1/sites/s/forms/survey/intake-responses?page_id=company', { method, ...(body ? { body: JSON.stringify(body) } : {}) }) } as any);
beforeEach(() => {
  vi.clearAllMocks(); auth.mockResolvedValue({ ok: true, value: { ...base, extensionIdentity: installation } });
  read.mockResolvedValue({ id: 'survey', target: { installation_id: 'i' } });
  list.mockResolvedValue([{ id: 'a'.repeat(64), form_id: 'survey', installation_id: 'i', data: { interest: false }, status: 'partial', intake: { reference: { page_id: 'company', review_id: 'review' }, steps: [], revision: 'x' } },
    { id: 'b'.repeat(64), form_id: 'survey', installation_id: 'other', data: { secret: 'never' }, intake: { reference: { page_id: 'company' } } }]);
});
it('rejects owner bearer auth and non-admin humans before reading private answers', async () => {
  auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await GET(context())).status).toBe(401); expect(read).not.toHaveBeenCalled();
  auth.mockResolvedValueOnce({ ok: true, value: { ...base, permission: 'write' } });
  expect((await GET(context())).status).toBe(403); expect(read).not.toHaveBeenCalled();
});
it('requires narrow intake permission and exact form installation ownership', async () => {
  auth.mockResolvedValueOnce({ ok: true, value: { ...base, extensionIdentity: { ...installation, scopes: ['forms:execute'] } } });
  expect((await GET(context())).status).toBe(403);
  auth.mockResolvedValueOnce({ ok: true, value: { ...base, extensionIdentity: { ...installation, installationId: 'other' } } });
  expect((await GET(context())).status).toBe(404); expect(list).not.toHaveBeenCalled();
});
it('returns private linked answers only to an admin or matching authorized installation', async () => {
  const response = await GET(context()), body = await response.json();
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(body.responses).toHaveLength(1); expect(body.responses[0].answers).toEqual({ interest: false });
  expect(JSON.stringify(body)).not.toContain('never');
});
it('does not retry notifications for another profile or completed ambiguous dispatch', async () => {
  read.mockResolvedValueOnce({ id: 'survey', target: { installation_id: 'i' } }).mockResolvedValueOnce({ form_id: 'survey', installation_id: 'i', intake: { reference: { page_id: 'other' } } });
  expect((await POST(context('POST', { submission_id: 'a'.repeat(64), event: 'first_answer' }))).status).toBe(404);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(['sending', 'accepted', 'unknown'])('never retries a %s notification', async status => {
  read.mockResolvedValueOnce({ id: 'survey', target: { installation_id: 'i' } }).mockResolvedValueOnce({ form_id: 'survey', installation_id: 'i', intake: { reference: { page_id: 'company' } }, notifications: { first_answer: { status, attempts: 1 } } });
  expect((await POST(context('POST', { submission_id: 'a'.repeat(64), event: 'first_answer' }))).status).toBe(409);
  expect(dispatch).not.toHaveBeenCalled();
});
it('forwards a deliberate pending retry only for the selected installation and profile', async () => {
  read.mockResolvedValueOnce({ id: 'survey', target: { installation_id: 'i' } }).mockResolvedValueOnce({ form_id: 'survey', installation_id: 'i', intake: { reference: { page_id: 'company' } }, notifications: { first_answer: { status: 'pending', attempts: 0 } } });
  expect((await POST(context('POST', { submission_id: 'a'.repeat(64), event: 'first_answer' }))).status).toBe(200);
  expect(dispatch).toHaveBeenCalledWith(expect.anything(), { orgId: 'o', siteId: 's', installationId: 'i' }, 'a'.repeat(64), { retry: true, event: 'first_answer' });
});
