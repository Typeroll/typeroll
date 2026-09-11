import assert from 'node:assert/strict';

export async function waitForDocsRelease(expectedSha, readSha, {
  attempts = 16,
  delay = () => new Promise(resolve => setTimeout(resolve, 2000)),
} = {}) {
  let actual;
  for (let attempt = 0; attempt < attempts; attempt++) {
    actual = await readSha();
    if (actual === expectedSha) return;
    if (attempt + 1 < attempts) await delay();
  }
  assert.equal(actual, expectedSha, 'Live docs do not match the deployed source after waiting for distribution');
}
