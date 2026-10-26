import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('starter Python QA preserves binding, integrity and URL semantics', () => {
  const result = spawnSync('python3', ['scripts/starter-qa-fixtures.py'], { encoding:'utf8', env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'} });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
