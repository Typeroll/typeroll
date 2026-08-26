import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRuntimeSnapshot } from '@typeroll/shared';
import { fetchPublicAsset } from './public-http';

export const MAX_EXTENSION_SCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_EXTENSION_STYLE_BYTES = 1024 * 1024;

function digest(bytes: Uint8Array): { hex: string; sri: string } {
  const raw = crypto.createHash('sha256').update(bytes).digest();
  return { hex: raw.toString('hex'), sri: `sha256-${raw.toString('base64url')}` };
}

export function assertExtensionAssetDigest(bytes: Uint8Array, expected: string, label: string): void {
  const actual = digest(bytes);
  if (expected.toLowerCase() !== actual.hex && expected !== actual.sri) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
}

export async function verifyExtensionAssets(
  manifest: ExtensionManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const component of manifest.frontend?.components ?? []) {
    if (component.render_mode !== 'bundled_component') continue;
    const entry = component.entry as { script_url: string; script_sha256: string; style_url?: string; style_sha256?: string };
    const script = await fetchPublicAsset(entry.script_url, MAX_EXTENSION_SCRIPT_BYTES, fetchImpl);
    assertExtensionAssetDigest(script, entry.script_sha256, `${component.id} script`);
    if (entry.style_url) {
      const style = await fetchPublicAsset(entry.style_url, MAX_EXTENSION_STYLE_BYTES, fetchImpl);
      assertExtensionAssetDigest(style, String(entry.style_sha256 ?? ''), `${component.id} style`);
    }
  }
}

export async function vendorExtensionAssets(
  buildDir: string,
  snapshot: ExtensionRuntimeSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const installation of snapshot.installations) {
    for (const component of installation.components) {
      if (component.render_mode !== 'bundled_component') continue;
      const entry = component.entry as { script_url: string; script_sha256: string; style_url?: string; style_sha256?: string };
      const script = await fetchPublicAsset(entry.script_url, MAX_EXTENSION_SCRIPT_BYTES, fetchImpl);
      assertExtensionAssetDigest(script, entry.script_sha256, `${component.id} script`);
      const scriptPath = path.join(buildDir, String(component.local_script_url).replace(/^\//, ''));
      await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.promises.writeFile(scriptPath, script);
      files += 1;
      bytes += script.byteLength;
      if (entry.style_url && component.local_style_url) {
        const style = await fetchPublicAsset(entry.style_url, MAX_EXTENSION_STYLE_BYTES, fetchImpl);
        assertExtensionAssetDigest(style, String(entry.style_sha256 ?? ''), `${component.id} style`);
        const stylePath = path.join(buildDir, component.local_style_url.replace(/^\//, ''));
        await fs.promises.mkdir(path.dirname(stylePath), { recursive: true });
        await fs.promises.writeFile(stylePath, style);
        files += 1;
        bytes += style.byteLength;
      }
    }
  }
  return { files, bytes };
}
