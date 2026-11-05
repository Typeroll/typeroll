// The Worker entry delegates every operator API method, so an RPC name the
// operator calls can never be missing from the entrypoint.
import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OPERATOR_API_METHOD_NAMES } from '../../lib/operator-api';

it('exports an OperatorApi entrypoint delegating every operator API method', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../worker.ts'), 'utf8');
  const block = source.slice(source.indexOf('export class OperatorApi'), source.indexOf('export default'));
  for (const name of OPERATOR_API_METHOD_NAMES) expect(block).toMatch(new RegExp(`\\n  ${name}\\(.*this\\.#api\\.${name}\\(`));
  expect(source).toMatch(/export class Scheduler extends WorkerEntrypoint/);
  expect(source).toMatch(/async scheduled\(/);
});

it('leaves expiry to the store TTL: the Cron handler only wakes overdue objects', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../worker.ts'), 'utf8');
  const scheduled = source.slice(source.indexOf('async scheduled('));
  expect(scheduled).toMatch(/sweepScheduledObjects\(/);
  expect(scheduled).not.toMatch(/removeExpired|retention/);
});
