import { expect, it, vi } from 'vitest';
import { staticChecks, verifyStaticResponse } from '../../lib/builds/verification';
import { sha256, assertFilePath } from '../../lib/builds/contract.mjs';
import { responseBytes, outputFiles } from '../../lib/builds/executor.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
it('checks current pages and assets plus removed routes without treating headers as content', () => {
  const before = staticChecks({ 'index.html': Buffer.from('old'), 'removed/index.html': Buffer.from('gone'), 'moved/index.html': Buffer.from('redirect') });
  const checks = staticChecks({ 'index.html': Buffer.from('new'), 'image.png': Buffer.from('png'), _headers: Buffer.from('/*\n X-Robots-Tag: noindex'), _redirects: Buffer.from('/moved/ / 301') }, before);
  expect(checks).toEqual([{ route: '/', status: 200, sha256: sha256('new') }, { route: '/image.png', status: 200, sha256: sha256('png') }, { route: '/removed/', status: 404 }]);
});
it('rejects stale bodies and deleted pages even when publication headers are fresh', async () => {
  const fetchImpl = vi.fn(async () => new Response('old', { headers: { 'x-typeroll-publication': 'new' } }));
  const validate = vi.fn(async () => undefined);
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate })).toBe(false);
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/removed', status: 404 }, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response('new'));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate })).toBe(true);
  fetchImpl.mockImplementation(async () => new Response('gone', { status: 404 }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/removed', status: 404 }, { fetchImpl, validate })).toBe(true);
});
it('does not follow redirects to another origin', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid/' } }));
  expect(await verifyStaticResponse('https://site.example.invalid', { route: '/', status: 200, sha256: sha256('new') }, { fetchImpl, validate: async () => undefined })).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('accepts a Cloudflare managed robots prefix only when the original file remains byte-identical', async () => {
  const original = 'User-agent: *\nDisallow: /\n';
  const prefix = '# As a condition of accessing this website\n# BEGIN Cloudflare Managed content\nUser-agent: *\nContent-Signal: search=yes,ai-train=no\n# END Cloudflare Managed Content\n\n';
  const check = { route: '/robots.txt', status: 200 as const, sha256: sha256(original) };
  const fetchImpl = vi.fn(async () => new Response(prefix + original));
  const validate = async () => undefined;
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(true);
  fetchImpl.mockImplementation(async () => new Response(prefix + 'User-agent: *\nAllow: /\n'));
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response(prefix));
  expect(await verifyStaticResponse('https://site.example.invalid', check, { fetchImpl, validate })).toBe(false);
  fetchImpl.mockImplementation(async () => new Response(prefix + original));
  expect(await verifyStaticResponse('https://site.example.invalid', { ...check, route: '/other.txt' }, { fetchImpl, validate })).toBe(false);
  expect(await verifyStaticResponse('https://site.example.invalid', { ...check, status: 404 }, { fetchImpl, validate })).toBe(false);
});
it('bounds streamed transfers and rejects private output files', async () => {
  await expect(responseBytes(new Response('12345'), 4)).rejects.toThrow('limit');
  for (const name of ['.env', '.env.local', '.npmrc', 'functions/a.js', '_worker.js']) expect(() => assertFilePath(name, { artifact: true })).toThrow('private');
});
it('rejects symbolic links and hard links before collecting output', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'typeroll-artifact-test-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), 'site'); await fs.symlink('index.html', path.join(root, 'linked.html'));
    await expect(outputFiles(root)).rejects.toThrow('unsafe');
    await fs.unlink(path.join(root, 'linked.html')); await fs.link(path.join(root, 'index.html'), path.join(root, 'linked.html'));
    await expect(outputFiles(root)).rejects.toThrow('unsafe');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
