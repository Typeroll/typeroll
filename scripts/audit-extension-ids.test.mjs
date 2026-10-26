import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExtensionPath, planExtensionIdReservations } from './lib/extension-id-audit.mjs';

test('parses only developer Extension documents', () => {
  assert.deepEqual(parseExtensionPath('organizations/dev/extensions/com.example.app'), { developer_org_id: 'dev', extension_id: 'com.example.app' });
  assert.equal(parseExtensionPath('organizations/dev/sites/site/extensions/inst_1'), null);
  assert.equal(parseExtensionPath('organizations/dev/extensions/com.example.app/versions/1.0.0'), null);
});

test('reports ids registered by several organizations and backfills only single owners', () => {
  const plan = planExtensionIdReservations({
    extensions: [
      { developer_org_id: 'victim', extension_id: 'com.victim.app', created_at: '2026-01-01T00:00:00Z' },
      { developer_org_id: 'attacker', extension_id: 'com.victim.app', created_at: '2026-02-01T00:00:00Z' },
      { developer_org_id: 'solo', extension_id: 'com.solo.app' },
      { developer_org_id: 'owner', extension_id: 'com.owner.app' },
      { developer_org_id: 'late', extension_id: 'com.taken.app' },
      { developer_org_id: 'other', extension_id: 'com.catalog.app' },
    ],
    reservations: new Map([['com.owner.app', 'owner'], ['com.taken.app', 'early'], ['com.gone.app', 'gone']]),
    catalog: new Map([['com.catalog.app', 'publisher']]),
  });
  assert.deepEqual(plan.contested.map(entry => [entry.extension_id, entry.registrations.map(r => r.developer_org_id)]), [
    ['com.victim.app', ['victim', 'attacker']],
  ]);
  assert.deepEqual(plan.backfill, [{ extension_id: 'com.solo.app', developer_org_id: 'solo' }]);
  assert.deepEqual(plan.reserved, [{ extension_id: 'com.owner.app', developer_org_id: 'owner' }]);
  assert.deepEqual(plan.conflicts.map(entry => entry.extension_id), ['com.catalog.app', 'com.taken.app']);
  assert.deepEqual(plan.orphaned_reservations, [{ extension_id: 'com.gone.app', reserved_by: 'gone' }]);
});

test('treats two records from the same organization as one owner', () => {
  const plan = planExtensionIdReservations({
    extensions: [
      { developer_org_id: 'dev', extension_id: 'com.dev.app' },
      { developer_org_id: 'dev', extension_id: 'com.dev.app' },
    ],
    reservations: new Map(),
    catalog: new Map(),
  });
  assert.deepEqual(plan.contested, []);
  assert.deepEqual(plan.backfill, [{ extension_id: 'com.dev.app', developer_org_id: 'dev' }]);
});
