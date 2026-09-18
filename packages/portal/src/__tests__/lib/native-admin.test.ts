import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionInstallation, ExtensionVersion } from '@typeroll/shared';
import { appApiUrl, verifiedModuleSource } from '../../lib/extensions/native-admin-client';
const mock = vi.hoisted(() => ({ getDoc: vi.fn() }));
vi.mock('../../lib/datastore', () => ({ getStore: () => mock }));
import { approvedNativeAdmin } from '../../lib/extensions/native-admin';

describe('native admin boundary', () => {
  const digest = 'a'.repeat(64);
  const installation = { developer_org_id: 'trusted-owner', extension_id: 'com.example.tool' } as ExtensionInstallation;
  const version = { manifest_sha256: digest, extension_id: installation.extension_id, status: 'published' } as ExtensionVersion;
  const approval = { enabled: true, developer_org_id: installation.developer_org_id, extension_id: installation.extension_id, manifest_sha256: digest };
  it('requires an active app and host approval of the exact published release and developer', async () => {
    let active = true;
    let current: Record<string, unknown> | null = null;
    mock.getDoc.mockImplementation(async (path: string) => path.startsWith('organizations/') ? { status: active ? 'active' : 'suspended' } : current);
    expect(await approvedNativeAdmin(installation, version)).toBe(false);
    current = approval; expect(await approvedNativeAdmin(installation, version)).toBe(true);
    for (const altered of [{ enabled: false }, { developer_org_id: 'impostor' }, { manifest_sha256: 'b'.repeat(64) }, { extension_id: 'other-app' }]) {
      current = { ...approval, ...altered }; expect(await approvedNativeAdmin(installation, version)).toBe(false);
    }
    current = approval; expect(await approvedNativeAdmin(installation, { ...version, status: 'draft' })).toBe(false);
    active = false; expect(await approvedNativeAdmin(installation, version)).toBe(false);
  });
  it('refuses altered module bytes before evaluation', async () => {
    const source = 'export const sdkVersion=1;'; const hash = createHash('sha256').update(source).digest('hex');
    expect(await verifiedModuleSource(new Response(source), hash)).toBe(source);
    await expect(verifiedModuleSource(new Response(source + 'alert(1)'), hash)).rejects.toThrow('integrity');
    await expect(verifiedModuleSource(new Response('x'.repeat(1024 * 1024 + 1)), hash)).rejects.toThrow('size limit');
  });
  it('keeps bearer-authenticated requests inside the approved API prefix', () => {
    expect(appApiUrl('https://app.example/v1', '/admin/status')).toBe('https://app.example/v1/admin/status');
    for (const path of ['//evil.example', '/../steal', '/%2e%2e/steal', '/\\evil.example', 'https://evil.example'])
      expect(() => appApiUrl('https://app.example/v1', path)).toThrow();
  });
});
