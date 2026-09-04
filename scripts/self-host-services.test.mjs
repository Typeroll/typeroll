import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFirebaseAdminTarget } from './lib/self-host-services.mjs';

test('Firebase administration supports service-account and keyless ADC targets', () => {
  assert.deepEqual(
    resolveFirebaseAdminTarget({
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'service-account-project' }),
      PUBLIC_FIREBASE_PROJECT_ID: 'service-account-project',
    }),
    {
      projectId: 'service-account-project',
      credentials: { project_id: 'service-account-project' },
    },
  );
  assert.deepEqual(
    resolveFirebaseAdminTarget({
      GOOGLE_CLOUD_PROJECT: 'adc-project',
      PUBLIC_FIREBASE_PROJECT_ID: 'adc-project',
    }),
    { projectId: 'adc-project', credentials: null },
  );
});

test('Firebase administration rejects malformed or mismatched targets', () => {
  assert.throws(
    () => resolveFirebaseAdminTarget({ FIREBASE_SERVICE_ACCOUNT: '{' }),
    /valid JSON/,
  );
  assert.throws(
    () => resolveFirebaseAdminTarget({
      GOOGLE_CLOUD_PROJECT: 'adc-project',
      PUBLIC_FIREBASE_PROJECT_ID: 'another-project',
    }),
    /must match/,
  );
  assert.throws(() => resolveFirebaseAdminTarget({}), /FIREBASE_SERVICE_ACCOUNT or GOOGLE_CLOUD_PROJECT/);
});
