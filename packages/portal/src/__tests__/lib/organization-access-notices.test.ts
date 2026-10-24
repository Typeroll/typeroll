import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { deliverAccessNotice } from '../../lib/organization-access-notices';
import { scheduledIndexWrites } from '../../lib/scheduling/index';
const period = { starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-01-31T00:00:00Z', read_until: '2026-05-01T00:00:00Z' };
const org = { service_access: { schema_version: 1, initial_period: period } };
const due = Date.parse(period.ends_at) - 7 * 86400000;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('TYPEROLL_ORGANIZATION_ACCESS_POLICY', JSON.stringify({ initial_days: 30, read_days: 90, contact_url: 'https://example.invalid/', own_smtp: true }));
  vi.stubEnv('TYPEROLL_ACCESS_NOTICE_SENDER', JSON.stringify({ orgId: 'platform', siteId: 'mail' }));
  await getStore().setDoc('organizations/a', org);
  for (const [id, role, joined_at] of [['owner', 'owner', period.starts_at], ['editor', 'editor', period.starts_at], ['new-admin', 'admin', '2026-01-25T00:00:00Z']]) {
    await getStore().setDoc(`organizations/a/members/${id}`, { role, joined_at, email: `${id}@example.invalid` });
  }
});
afterEach(() => vi.unstubAllEnvs());
it('indexes only three durable deadlines, unchanged org edits do not replay them', () => {
  const writes = scheduledIndexWrites('organizations/a', null, org);
  expect(writes).toHaveLength(3);
  expect(writes[0].data?.due_at).toBe(due);
  expect(scheduledIndexWrites('organizations/a', org, { ...org, name: 'Changed' })).toEqual([]);
  expect(scheduledIndexWrites('organizations/a', org, { ...org, service_access: { ...org.service_access, override: { state: 'active' } } }).every(w => w.data === null)).toBe(true);
});
it('notifies existing admins only, records one delivery, and never replays old batches', async () => {
  const send = vi.fn().mockResolvedValue({ id: 'mail', status: 'accepted' });
  await deliverAccessNotice('a', period.ends_at, 7, due, send);
  await deliverAccessNotice('a', period.ends_at, 7, due + 1, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({ to: 'owner@example.invalid' });
  expect(send.mock.calls[0][1].text).toContain('No payment is taken automatically');
  await deliverAccessNotice('a', period.ends_at, 1, Date.parse(period.ends_at), send);
  expect(send).toHaveBeenCalledTimes(1);
  await getStore().updateDoc('organizations/a', { service_access: { ...org.service_access, override: { state: 'active' } } });
  await deliverAccessNotice('a', period.ends_at, 0, Date.parse(period.ends_at), send);
  expect(send).toHaveBeenCalledTimes(1);
});
it('retains uncertain mail without automatic resend', async () => {
  const send = vi.fn().mockResolvedValue({ id: 'uncertain', status: 'unknown' });
  await deliverAccessNotice('a', period.ends_at, 7, due, send);
  await deliverAccessNotice('a', period.ends_at, 7, due + 10, send);
  expect(send).toHaveBeenCalledTimes(1);
});
