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

// A page added in this release can still answer 404 at the edge for a few
// seconds after release.json already reports the new source, so a single
// 404 is retried before it counts as missing.
export async function waitForPublished(load, {
  attempts = 15,
  delay = () => new Promise(resolve => setTimeout(resolve, 2000)),
} = {}) {
  let response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    response = await load();
    if (response.status !== 404) return response;
    if (attempt + 1 < attempts) {
      await response.arrayBuffer();
      await delay();
    }
  }
  return response;
}
