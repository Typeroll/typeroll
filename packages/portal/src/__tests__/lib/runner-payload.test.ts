import { expect, it } from 'vitest';
import { publishingJsonBody } from '../../lib/publishing/http';
import { MAX_RUNNER_RESULT_BYTES, MAX_SEO_REPORT_CHARACTERS, MAX_SEO_REPORT_BYTES, seoReport } from '../../lib/builds/contract.mjs';
import { reportBuildFailure } from '../../lib/builds/executor.mjs';

function streamed(text: string, declared?: number) {
  const bytes = Buffer.from(text);
  let cursor = 0;
  return new Request('https://fixture.invalid', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(declared === undefined ? {} : { 'content-length': String(declared) }) },
    body: new ReadableStream({ pull(controller) { if (cursor === bytes.length) { controller.close(); return; } const end = Math.min(cursor + 1024, bytes.length); controller.enqueue(bytes.subarray(cursor, end)); cursor = end; } }),
    duplex: 'half',
  } as RequestInit);
}
it('bounds UTF-8 bytes rather than characters, regardless of declared length or chunking', async () => {
  const data = JSON.stringify({ value: '漢'.repeat(260000) });
  expect(data.length).toBeLessThan(MAX_RUNNER_RESULT_BYTES);
  expect(Buffer.byteLength(data)).toBeGreaterThan(MAX_RUNNER_RESULT_BYTES);
  for (const length of [undefined, 1, Buffer.byteLength(data)]) await expect(publishingJsonBody(streamed(data, length), MAX_RUNNER_RESULT_BYTES)).rejects.toMatchObject({ status: 413 });
  const exact = JSON.stringify({ value: 'x'.repeat(MAX_RUNNER_RESULT_BYTES - 12) });
  expect(Buffer.byteLength(exact)).toBe(MAX_RUNNER_RESULT_BYTES);
  await expect(publishingJsonBody(streamed(exact), MAX_RUNNER_RESULT_BYTES)).resolves.toHaveProperty('value');
  await expect(publishingJsonBody(streamed(exact + ' '), MAX_RUNNER_RESULT_BYTES)).rejects.toMatchObject({ status: 413 });
  await expect(publishingJsonBody(streamed(JSON.stringify({ value: 'x'.repeat(8192) })))).rejects.toMatchObject({ status: 413 });
});
it('fits a near-maximum valid Unicode report and the attempt envelope', async () => {
  const warning = { code: 'metadata_missing', url: 'https://fixture.invalid/', source: { file: 'index.html', line: 1 }, message: '漢'.repeat(3500), remediation: 'Review metadata.' };
  const report = { version: 1, publication_id: 'b'.repeat(64), source_sha256: 'a'.repeat(64), configuration_sha256: 'c'.repeat(64), artifact_tree_sha256: 'd'.repeat(64), passed: true, checked_pages: 100, error_count: 0, warning_count: 66, errors: [], warnings: Array.from({ length: 66 }, () => warning) };
  expect(JSON.stringify(report).length).toBeLessThan(MAX_SEO_REPORT_CHARACTERS);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeGreaterThan(250000);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(MAX_SEO_REPORT_BYTES);
  seoReport(report, report.publication_id);
  const parsed = await publishingJsonBody(streamed(JSON.stringify({ key: 'e'.repeat(64), lease_id: 'f'.repeat(36), revision: 'g'.repeat(36), seo_report: report })), MAX_RUNNER_RESULT_BYTES);
  expect(parsed.seo_report).toEqual(report);
});
it('reports an explicit oversized failure without its report and never retries other failures', async () => {
  const sent: any[] = [];
  await reportBuildFailure(async (_action: string, _token: string, payload: unknown) => { sent.push(payload); if (sent.length === 1) throw Error('coordinator_413'); }, 'token', { key: 'key', lease_id: 'lease' }, { code: 'coordinator_413', stage: 'artifact', validation: { report: true } });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ key: 'key', lease_id: 'lease', code: 'publication_report_too_large', stage: 'artifact' });
  for (const error of ['coordinator_409', 'coordinator_401', 'coordinator_502', 'network']) {
    let calls = 0;
    await expect(reportBuildFailure(async () => { calls++; throw Error(error); }, 'token', {}, { code: 'failed', stage: 'artifact', validation: {} })).rejects.toThrow(error);
    expect(calls).toBe(1);
  }
});
