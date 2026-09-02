import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readCoreVersions,
  verifyCoreReleaseVersion,
} from './verify-core-release.mjs';

test('the repository Core version sources agree', () => {
  const versions = readCoreVersions();
  assert.equal(verifyCoreReleaseVersion(`core-v${versions.package}`, versions), versions.package);
});

test('the release guard accepts a tag matching every Core version source', () => {
  const versions = { package: '1.2.3', runtime: '1.2.3', selfHost: '1.2.3' };
  assert.equal(verifyCoreReleaseVersion('core-v1.2.3', versions), '1.2.3');
});

test('the release guard rejects a tag or source version mismatch', () => {
  assert.throws(
    () => verifyCoreReleaseVersion('core-v1.2.3', {
      package: '1.2.3',
      runtime: '1.2.2',
      selfHost: '1.2.3',
    }),
    /runtime=1\.2\.2/,
  );
  assert.throws(
    () => verifyCoreReleaseVersion('v1.2.3', {
      package: '1.2.3',
      runtime: '1.2.3',
      selfHost: '1.2.3',
    }),
    /Expected a Core release tag/,
  );
});
