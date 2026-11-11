// The organization build engine PUTs the finished artifact to build storage.
// R2 answering HTTP 5xx for a moment used to fail the whole publication
// (artifact_artifact_upload_failed) although a retry a minute later succeeded.
import { expect, it, vi } from 'vitest';
import { putArtifact, transferFailureReason, failureDiagnostic } from '../../lib/builds/executor.mjs';
import { buildFailureMessage } from '../../lib/builds/failure-message';

const url = new URL('https://account.r2.cloudflarestorage.com/bucket/artifact.json?X-Amz-Signature=secret-signature');
const request = { contentType: 'application/octet-stream', body: new Uint8Array([1, 2, 3]), timeout: 1000 };
const quiet = () => ({ log: vi.fn((_line: string) => {}), sleep: vi.fn(async (_ms: number) => {}) });

it('repeats a PUT that build storage refused with a transient status, then succeeds', async () => {
  const answers = [new Response(null, { status: 503 }), new Response(null, { status: 500 }), new Response(null, { status: 200 })];
  const fetchImpl = vi.fn(async () => answers.shift()!);
  const options = quiet();
  await putArtifact(fetchImpl as unknown as typeof fetch, url, request, options);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(options.sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000]);
  const lines = options.log.mock.calls.map(([line]) => line).join('\n');
  expect(lines).toContain('attempt 1/3 failed (HTTP 503)');
  expect(lines).toContain('succeeded on attempt 3/3');
  expect(lines).not.toContain('r2.cloudflarestorage.com');
  expect(lines).not.toContain('secret-signature');
});

it('repeats network errors and reports the final status as the failure cause without the URL', async () => {
  const fetchImpl = vi.fn(async () => { throw Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: 'ECONNRESET' } }); });
  const options = quiet();
  const error = await putArtifact(fetchImpl as unknown as typeof fetch, url, request, options).catch(value => value);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(error.message).toBe('artifact_upload_failed');
  const diagnostic = failureDiagnostic(error, 'artifact_upload_failed');
  expect(diagnostic?.cause).toBe('Error: build storage refused the artifact upload (network error ECONNRESET).');
  expect(JSON.stringify([diagnostic, options.log.mock.calls])).not.toContain('cloudflarestorage');
});

it('does not repeat a PUT that build storage rejected as a client error', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
  const options = quiet();
  const error = await putArtifact(fetchImpl as unknown as typeof fetch, url, request, options).catch(value => value);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(options.sleep).not.toHaveBeenCalled();
  expect(failureDiagnostic(error, 'artifact_upload_failed')?.cause).toContain('(HTTP 403)');
});

it('stops repeating once another attempt would exceed the time budget', async () => {
  let clock = 0;
  const fetchImpl = vi.fn(async () => { clock += 1000; return new Response(null, { status: 502 }); });
  await expect(putArtifact(fetchImpl as unknown as typeof fetch, url, request, { ...quiet(), now: () => clock, budget: 3500 })).rejects.toThrow('artifact_upload_failed');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('names only a status, a bare code or the error class for an optional cache read', () => {
  expect(transferFailureReason(Error('HTTP 503'))).toBe('HTTP 503');
  expect(transferFailureReason(Error('render_cache_integrity'))).toBe('render_cache_integrity');
  expect(transferFailureReason(Object.assign(Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe('timed out');
  expect(transferFailureReason(new TypeError(`fetch failed ${url}`))).toBe('network error');
  expect(transferFailureReason(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe('SyntaxError');
});

it('tells the reader that a storage refusal is temporary, retried once and leaves the live site unchanged', () => {
  const message = buildFailureMessage('artifact_artifact_upload_failed', { cause: 'Error: build storage refused the artifact upload (HTTP 503).', lines: [] });
  expect(message).toMatch(/^The build failed while uploading the built site: build storage did not accept the built site\./);
  expect(message).toContain('Cause: Error: build storage refused the artifact upload (HTTP 503).');
  expect(message).toContain('retried once automatically');
  expect(message).toContain('the live site is unchanged');
  expect(message).toMatch(/\(artifact_artifact_upload_failed\)$/);
});
