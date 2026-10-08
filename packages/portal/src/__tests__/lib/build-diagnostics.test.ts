import { expect, it } from 'vitest';
import { buildDiagnostic, diagnosticCause, normalizeDiagnostic, secretValues, DIAGNOSTIC_LINES } from '../../lib/builds/diagnostics.mjs';
import { failureDiagnostic, reportBuildFailure } from '../../lib/builds/executor.mjs';

// What Node prints when the media step of Core 0.2.73 met a receipt from an earlier sharp release.
const mediaFailure = `TYPEROLL_RENDER_CACHE unavailable; rendering without a baseline
file:///work/scripts/media.mjs:141
        throw new Error('Invalid media completion receipt');
              ^

Error: Invalid media completion receipt
    at prepareEntry (file:///work/scripts/media.mjs:141:120)
    at async Promise.allSettled (index 0)
    at async prepareMediaBatch (file:///work/scripts/media.mjs:298:21)

Node.js v22.20.0`;

it('names what the failed step threw and keeps the lines that led to it', () => {
  const diagnostic = buildDiagnostic(mediaFailure);
  expect(diagnostic.cause).toBe('Error: Invalid media completion receipt');
  expect(diagnostic.lines).toContain('    at prepareEntry (file:///work/scripts/media.mjs:141:120)');
  expect(diagnostic.lines.at(-1)).toBe('Node.js v22.20.0');
});

it('picks a specific failure line over a generic one when nothing was thrown', () => {
  expect(diagnosticCause(['npm error code ERESOLVE', 'npm error A complete log of this run can be found in /tmp/x.log'])).toBe('npm error code ERESOLVE');
  expect(diagnosticCause(['Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'sharp\' imported from /work/scripts/media.mjs'])).toMatch(/^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package/);
  expect(diagnosticCause(['all good'])).toBeNull();
  // The supervisor's own cause line wins, so a provider log names the same cause as the job.
  expect(diagnosticCause(['Error: inner', 'TYPEROLL_BUILD_CAUSE Error: Invalid media completion receipt', 'TYPEROLL_BUILD_FAILED media_build_process_exit_1'])).toBe('Error: Invalid media completion receipt');
});

it('removes the exact credentials an attempt holds and anything credential-shaped', () => {
  const access = { grant_url: 'https://acct.r2.cloudflarestorage.com/grant?X-Amz-Signature=deadbeef', sha256: 'a'.repeat(64), secret_access_key: 'short-but-secret-value' };
  const secrets = secretValues(['runner-token-value', JSON.stringify(access)]);
  const diagnostic = buildDiagnostic(`token runner-token-value leaked\nkey short-but-secret-value leaked\nfetch ${access.grant_url}`, secrets);
  expect(diagnostic.lines.join('\n')).not.toMatch(/runner-token-value|short-but-secret-value|deadbeef/);
});

it('bounds the tail and accepts a reported diagnostic only in its own shape', () => {
  const long = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
  expect(buildDiagnostic(long).lines).toHaveLength(DIAGNOSTIC_LINES);
  expect(normalizeDiagnostic('Error: text')).toBeUndefined();
  expect(normalizeDiagnostic({ lines: [] })).toBeUndefined();
  expect(normalizeDiagnostic({ cause: 7, lines: ['Error: boom', { nested: true }] })).toEqual({ cause: 'Error: boom', lines: ['Error: boom'] });
  expect(normalizeDiagnostic({ cause: 'Authorization: Bearer abc', lines: [] })).toEqual({ cause: 'Authorization: [redacted]', lines: [] });
  expect(normalizeDiagnostic({ cause: null, lines: Array.from({ length: 500 }, () => 'x'.repeat(5000)) })!.lines.every(line => line.length <= 400)).toBe(true);
});

it('reports what a failed step printed, and the message when the supervisor itself failed', () => {
  const step = Object.assign(Error('build_process_exit_1'), { output: mediaFailure });
  expect(failureDiagnostic(step, 'build_process_exit_1')?.cause).toBe('Error: Invalid media completion receipt');
  expect(failureDiagnostic(new SyntaxError('Unexpected token < in JSON at position 0'), 'build_failed')?.cause).toBe('SyntaxError: Unexpected token < in JSON at position 0');
  // A bare code is already the reported code.
  expect(failureDiagnostic(Error('media_preparation_scope_mismatch'), 'media_preparation_scope_mismatch')).toBeUndefined();
});

it('sends the diagnostic with the failure and keeps only its cause when the report is too large', async () => {
  const sent: any[] = [], diagnostic = { cause: 'Error: boom', lines: ['Error: boom', 'at x'] };
  await reportBuildFailure(async (_action: string, _token: string, payload: unknown) => { sent.push(payload); }, 'token', { key: 'k', lease_id: 'l' }, { code: 'build_process_exit_1', stage: 'media', diagnostic });
  expect(sent).toEqual([{ key: 'k', lease_id: 'l', code: 'build_process_exit_1', stage: 'media', diagnostic }]);
  sent.length = 0;
  await reportBuildFailure(async (_action: string, _token: string, payload: unknown) => { sent.push(payload); if (sent.length === 1) throw Error('coordinator_413'); }, 'token', { key: 'k', lease_id: 'l' }, { code: 'build_process_exit_1', stage: 'media', diagnostic });
  expect(sent[1]).toEqual({ key: 'k', lease_id: 'l', code: 'build_process_exit_1', stage: 'media', diagnostic: { cause: 'Error: boom', lines: [] } });
});

it('keeps what a real failing step printed on both streams, in order', async () => {
  const { runStep } = await import('../../lib/builds/executor.mjs');
  const script = "console.log('rendering 12 pages'); console.error('Error: Invalid media completion receipt'); process.exit(1)";
  const error = await runStep(process.execPath, ['-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 10000, signal: new AbortController().signal }).catch(failure => failure);
  expect(error.message).toBe('build_process_exit_1');
  expect(error.output).toBe('rendering 12 pages\nError: Invalid media completion receipt\n');
  expect(failureDiagnostic(error, 'build_process_exit_1')?.cause).toBe('Error: Invalid media completion receipt');
  await expect(runStep(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 10000, signal: new AbortController().signal })).resolves.toBeUndefined();
});

it('says a step was stopped at its time limit', async () => {
  const { runStep } = await import('../../lib/builds/executor.mjs');
  const error = await runStep(process.execPath, ['-e', "console.error('still working'); setTimeout(() => {}, 60000)"], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 500, signal: new AbortController().signal }).catch(failure => failure);
  expect(error.message).toBe('build_process_timeout');
  expect(error.output).toMatch(/still working\n+The step was stopped after its time limit\.$/);
});
