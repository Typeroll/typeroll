import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionMetadataUpdate, parseInstallSite, runExtensionCli, validateExtensionManifestShape } from '../src/extension-cli';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPEROLL_API_URL;
  delete process.env.TYPEROLL_API_KEY;
});

describe('Extension CLI preflight', () => {
  it('accepts the documented manifest shape and catches invalid assets', () => {
    const valid = {
      schema_version: 3,
      id: 'se.vendor.quote-generator',
      name: 'Quote Generator',
      version: '1.0.0',
      runtime_compatibility: '>=0.38.0 <1.0.0',
      distribution: 'private',
      developer: { name: 'Vendor' },
      frontend: { components: [{
        id: 'quote', label: 'Quote', render_mode: 'bundled_component',
        entry: { script_url: 'https://vendor.example/index.js', script_sha256: 'a'.repeat(64) },
      }] },
    };
    expect(validateExtensionManifestShape(valid)).toEqual([]);
    expect(validateExtensionManifestShape({ ...valid, frontend: { components: [{
      id: 'quote', label: 'Quote', render_mode: 'bundled_component', entry: { script_url: 'https://vendor.example/index.js', script_sha256: 'wrong' },
    }] } })).toContain('frontend.components[0] needs script_url and lowercase SHA-256');
  });

  it('does not resubmit an unchanged immutable distribution', () => {
    const manifest = {
      name: 'Quote Generator',
      distribution: 'public',
    };
    const registered = {
      distribution: 'public',
      trusted_origins: ['https://vendor.example'],
    };

    expect(extensionMetadataUpdate(manifest, registered, ['https://vendor.example'])).toEqual({
      name: 'Quote Generator',
      trusted_origins: ['https://vendor.example'],
    });
    expect(extensionMetadataUpdate(
      { ...manifest, distribution: 'unlisted' },
      registered,
      ['https://assets.vendor.example'],
    )).toEqual({
      name: 'Quote Generator',
      distribution: 'unlisted',
      trusted_origins: ['https://vendor.example', 'https://assets.vendor.example'],
    });
  });

  it('configures an installation and queues a production deploy by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typeroll-extension-cli-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ policy_url: '/privacy/' }));
    process.env.TYPEROLL_API_URL = 'https://app.example.com';
    process.env.TYPEROLL_API_KEY = 'typeroll_live_test';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        installation: { id: 'install-1' },
        redeploy_required: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'deploy-1' }), { status: 202 }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(runExtensionCli([
        'configure',
        '--site', 'site-1',
        '--installation', 'install-1',
        '--config', configPath,
      ])).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://app.example.com/api/v1/sites/site-1/extensions/install-1',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ config: { policy_url: '/privacy/' } }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://app.example.com/api/v1/sites/site-1/deploy',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ environment: 'production' }),
    });
  });

  it('can save config without deploying when explicitly requested', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typeroll-extension-cli-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ heading: 'Preview' }));
    process.env.TYPEROLL_API_URL = 'https://app.example.com';
    process.env.TYPEROLL_API_KEY = 'typeroll_live_test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ redeploy_required: true }), { status: 200 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(runExtensionCli([
        'configure', '--site', 'site-1', '--installation', 'install-1',
        '--config', configPath, '--no-deploy',
      ])).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports partial success when config is saved but deploy enqueueing fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typeroll-extension-cli-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ heading: 'Saved' }));
    process.env.TYPEROLL_API_URL = 'https://app.example.com';
    process.env.TYPEROLL_API_KEY = 'typeroll_live_test';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ redeploy_required: true }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Queue unavailable' }),
        { status: 503 },
      ));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(runExtensionCli([
        'configure', '--site', 'site-1', '--installation', 'install-1',
        '--config', configPath,
      ])).resolves.toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(
      'configuration was saved, but the deploy could not be queued: Queue unavailable',
    ));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(
      'The saved configuration still requires a deploy.',
    ));
  });
});

describe('Extension CLI install on a private allow-list', () => {
  const manifest = {
    schema_version: 3,
    id: 'se.vendor.quote-generator',
    name: 'Quote Generator',
    version: '1.0.0',
    runtime_compatibility: '>=0.38.0 <1.0.0',
    distribution: 'private',
    developer: { name: 'Vendor' },
    permissions: [{ scope: 'content:read' }],
  };

  async function install(site: string, allowed: string[] = []) {
    const directory = await mkdtemp(join(tmpdir(), 'typeroll-extension-cli-'));
    const manifestPath = join(directory, 'typeroll-extension.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    process.env.TYPEROLL_API_URL = 'https://app.example.com';
    process.env.TYPEROLL_API_KEY = 'typeroll_live_test';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ extension: { allowed_site_ids: allowed } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ extension: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ installation: { id: 'inst_1' } }), { status: 201 }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = await runExtensionCli(['install', '--site', site, '--manifest', manifestPath]);
      return { code, fetchMock, errorLog };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('parses bare and organization-qualified sites and refuses anything else', () => {
    expect(parseInstallSite('site-1')).toEqual({ siteId: 'site-1', ownerOrgId: null, allowEntry: 'site-1' });
    expect(parseInstallSite('client-org/site-1')).toEqual({ siteId: 'site-1', ownerOrgId: 'client-org', allowEntry: 'client-org/site-1' });
    for (const value of ['', 'a/b/c', '/site', 'org/', '../site', 'org/..', 'has space']) {
      expect(() => parseInstallSite(value), value).toThrow('--site must be');
    }
  });

  it('writes org/site to allowed_site_ids and declares the owner when installing', async () => {
    const { code, fetchMock, errorLog } = await install('client-org/site-1', ['own-site']);
    expect(code).toBe(0);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://app.example.com/api/developer/extensions/se.vendor.quote-generator');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ allowed_site_ids: ['own-site', 'client-org/site-1'] });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://app.example.com/api/v1/sites/site-1/extensions');
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Typeroll-Organization')).toBe('client-org');
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining('only allows a site of your developer organization'));
  });

  it('keeps a bare id for the developer organization and explains how to allow another one', async () => {
    const { code, fetchMock, errorLog } = await install('site-1');
    expect(code).toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ allowed_site_ids: ['site-1'] });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://app.example.com/api/v1/sites/site-1/extensions');
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Typeroll-Organization')).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('--site <organization-id>/<site-id>'));
  });

  it('refuses a malformed --site before calling the API', async () => {
    const { code, fetchMock } = await install('a/b/c');
    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
