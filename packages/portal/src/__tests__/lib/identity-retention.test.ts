import { expect, it } from 'vitest';
import { removeExpiredAuthRecords } from '../../lib/identity/retention';
import { memoryStore } from '../helpers/identity';

it('removes sign-in records a day after they expired and keeps the rest', async () => {
  const store = memoryStore();
  const now = Date.parse('2026-11-05T12:00:00Z');
  await store.setDoc('auth_session/old', { expiresAt: '2026-11-03T00:00:00.000Z', token: 't1' });
  await store.setDoc('auth_session/recent', { expiresAt: '2026-11-05T00:00:00.000Z', token: 't2' });
  await store.setDoc('auth_session/live', { expiresAt: '2026-11-19T00:00:00.000Z', token: 't3' });
  await store.setDoc('mcp_authorization_codes/a', { expires_at: now - 3 * 86_400_000 });
  await store.setDoc('mcp_refresh_uses/b', { expires_at: now + 1000 });
  await store.setDoc('operator_auth_verification/c', { expiresAt: 'not a date' });
  const removed = await removeExpiredAuthRecords(store, now);
  expect(removed).toMatchObject({ auth_session: 1, mcp_authorization_codes: 1, mcp_refresh_uses: 0, operator_auth_verification: 0 });
  expect((await store.listDocs('auth_session')).map(doc => doc.id).sort()).toEqual(['live', 'recent']);
  expect(await store.getDoc('operator_auth_verification/c')).not.toBeNull();
});
