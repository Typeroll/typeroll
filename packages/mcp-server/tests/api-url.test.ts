import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrlProblem } from '../src/api-url';
import { runExtensionCli } from '../src/extension-cli';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPEROLL_API_URL;
  delete process.env.TYPEROLL_API_KEY;
});

describe('TYPEROLL_API_URL transport policy', () => {
  it('requires HTTPS except on loopback', () => {
    expect(apiUrlProblem('https://app.typeroll.com')).toBeNull();
    expect(apiUrlProblem('https://cms.example.com/')).toBeNull();
    expect(apiUrlProblem('http://localhost:4321')).toBeNull();
    expect(apiUrlProblem('http://127.0.0.1:4321')).toBeNull();
    expect(apiUrlProblem('http://[::1]:4321')).toBeNull();
    expect(apiUrlProblem('http://cms.example.com')).toMatch(/HTTPS/);
    expect(apiUrlProblem('http://localhost.example.com')).toMatch(/HTTPS/);
    expect(apiUrlProblem('ftp://cms.example.com')).toMatch(/HTTPS/);
    expect(apiUrlProblem('https://user:pass@cms.example.com')).toMatch(/credentials/);
    expect(apiUrlProblem('cms.example.com')).toMatch(/absolute URL/);
  });

  it('refuses to send the Extension CLI key over plain HTTP', async () => {
    process.env.TYPEROLL_API_URL = 'http://cms.example.com';
    process.env.TYPEROLL_API_KEY = 'typeroll_live_test';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const directory = await mkdtemp(join(tmpdir(), 'typeroll-api-url-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ heading: 'Saved' }));
    try {
      await expect(runExtensionCli(['configure', '--site', 'site-1', '--installation', 'install-1', '--config', configPath, '--no-deploy'])).resolves.toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/HTTPS/);
  });
});
