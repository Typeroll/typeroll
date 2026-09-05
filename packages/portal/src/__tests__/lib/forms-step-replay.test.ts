import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { signFormToken, signFormState } from '../../lib/forms-signing';
import { POST } from '../../pages/api/forms/submit';
const actions = vi.hoisted(() => ({ before: vi.fn(), after: vi.fn() }));
vi.mock('../../lib/forms/actions', () => ({ runBeforeActions: actions.before, runFormActions: actions.after }));
const subPath = `${paths.submissions('test-org', 'test-site')}/test-submission`;
let state: string;
beforeEach(async () => {
  vi.resetAllMocks();
  actions.before.mockResolvedValue({ ok: true });
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(`${paths.forms('test-org', 'test-site')}/test-form`, {
    name: 'Test', actions: [], steps: [
      { id: 'first', blocks: [] },
      { id: 'last', blocks: [{ id: 'name', type: 'form/text', data: { name: 'name', label: 'Name' } }] },
    ],
  });
  await getStore().setDoc(subPath, { form_id: 'test-form', status: 'partial', step: 'first', data: { previous: 'preserved' } });
  state = signFormState({ orgId: 'test-org', siteId: 'test-site', formId: 'test-form', submissionId: 'test-submission', step: 'first', iat: Date.now() - 2000 });
});
async function submit(name = 'Original') {
  return await POST({ request: new Request('https://portal.test/api/forms/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: signFormToken('test-org', 'test-site', 'test-form'), data: { _state: state, _protocol: '1', name } }),
  }) } as never) as Response;
}
it('rejects a completed-step replay without changing data or repeating actions', async () => {
  expect((await submit()).status).toBe(200);
  expect((await submit('Changed')).status).toBe(409);
  expect(actions.after).toHaveBeenCalledOnce();
  expect(await getStore().getDoc(subPath)).toMatchObject({ status: 'complete', data: { name: 'Original', previous: 'preserved' } });
});
it('allows only one concurrent request to complete the step and run actions', async () => {
  let entered = 0;
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => { release = resolve; });
  actions.before.mockImplementation(async () => { if (++entered === 2) release(); await bothReady; return { ok: true }; });
  const responses = await Promise.all([submit('First'), submit('Second')]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(actions.after).toHaveBeenCalledOnce();
});
it('rejects a continuation whose saved step has already advanced', async () => {
  await getStore().updateDoc(subPath, { step: 'later-step' });
  expect((await submit()).status).toBe(409);
  expect(actions.before).not.toHaveBeenCalled();
  expect(actions.after).not.toHaveBeenCalled();
});
