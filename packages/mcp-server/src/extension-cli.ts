import { readFile } from 'node:fs/promises';

type Json = Record<string, unknown>;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJson(path: string): Promise<Json> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as Json;
}

export function validateExtensionManifestShape(manifest: Json): string[] {
  const errors: string[] = [];
  if (manifest.schema_version !== 3) errors.push('schema_version must be 3');
  if (typeof manifest.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9][a-z0-9-]*){2,}$/.test(manifest.id)) errors.push('id must be a lowercase namespaced identifier');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name is required');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('version must be semver');
  if (typeof manifest.runtime_compatibility !== 'string' || !manifest.runtime_compatibility.trim()) errors.push('runtime_compatibility is required');
  if (!['private', 'unlisted', 'public'].includes(String(manifest.distribution))) errors.push('distribution must be private, unlisted or public');
  const developer = manifest.developer as Json | undefined;
  if (!developer || typeof developer.name !== 'string') errors.push('developer.name is required');
  const frontend = manifest.frontend as Json | undefined;
  const components = frontend?.components;
  if (components !== undefined && !Array.isArray(components)) errors.push('frontend.components must be an array');
  for (const [index, value] of (Array.isArray(components) ? components : []).entries()) {
    const component = value as Json;
    const entry = component?.entry as Json | undefined;
    if (!component || typeof component.id !== 'string' || typeof component.label !== 'string') errors.push(`frontend.components[${index}] needs id and label`);
    if (!['bundled_component', 'embedded_app'].includes(String(component?.render_mode))) errors.push(`frontend.components[${index}].render_mode is invalid`);
    if (component?.render_mode === 'bundled_component' && (!entry || typeof entry.script_url !== 'string' || !/^[a-f0-9]{64}$/.test(String(entry.script_sha256)))) {
      errors.push(`frontend.components[${index}] needs script_url and lowercase SHA-256`);
    }
    if (component?.render_mode === 'embedded_app' && (!entry || typeof entry.frame_url !== 'string')) errors.push(`frontend.components[${index}] needs frame_url`);
  }
  return errors;
}

function executionOrigins(manifest: Json): string[] {
  const urls: string[] = [];
  const components = ((manifest.frontend as Json | undefined)?.components ?? []) as Json[];
  for (const component of components) {
    const entry = component.entry as Json;
    for (const key of ['script_url', 'style_url', 'frame_url']) if (typeof entry?.[key] === 'string') urls.push(entry[key] as string);
  }
  const pages = ((manifest.admin as Json | undefined)?.pages ?? []) as Json[];
  for (const page of pages) if (typeof page.launch_url === 'string') urls.push(page.launch_url);
  for (const value of [
    (manifest.api as Json | undefined)?.base_url,
    (manifest.events as Json | undefined)?.webhook_url,
    (manifest.auth as Json | undefined)?.pairing_url,
  ]) if (typeof value === 'string') urls.push(value);
  return [...new Set(urls.map((value) => new URL(value).origin))];
}

async function api(path: string, init: RequestInit = {}, allowed: number[] = []): Promise<{ status: number; data: Json }> {
  const baseUrl = process.env.TYPEROLL_API_URL?.trim().replace(/\/$/, '');
  const apiKey = process.env.TYPEROLL_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error('TYPEROLL_API_URL and TYPEROLL_API_KEY are required');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({})) as Json;
  if (!response.ok && !allowed.includes(response.status)) throw new Error(String(data.error ?? `Typeroll API returned ${response.status}`));
  return { status: response.status, data };
}

function help(): void {
  console.error('Usage:');
  console.error('  typeroll extension validate [manifest]');
  console.error('  typeroll extension push --draft [--manifest path]');
  console.error('  typeroll extension install --site <site-id> [--manifest path] [--config config.json]');
  console.error('  typeroll extension promote <version> [--manifest path]');
}

export async function runExtensionCli(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || ['help', '--help', '-h'].includes(command)) { help(); return 0; }
  const manifestPath = option(args, '--manifest') ?? (command === 'validate' && args[1] && !args[1].startsWith('-') ? args[1] : 'typeroll-extension.json');
  try {
    const manifest = await readJson(manifestPath);
    const errors = validateExtensionManifestShape(manifest);
    if (errors.length) {
      for (const error of errors) console.error(`- ${error}`);
      return 1;
    }
    if (command === 'validate') {
      console.log(`${manifestPath}: valid manifest v3 shape (server validation remains authoritative)`);
      return 0;
    }
    const extensionId = String(manifest.id);
    if (command === 'push') {
      const current = await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}`, {}, [404]);
      if (current.status === 404) {
        const created = await api('/api/developer/extensions', {
          method: 'POST',
          body: JSON.stringify({
            id: extensionId,
            name: manifest.name,
            distribution: manifest.distribution,
            trusted_origins: executionOrigins(manifest),
          }),
        });
        if (created.data.client_secret) console.error('Extension client secret (shown once):', created.data.client_secret);
      } else {
        const registered = current.data.extension as Json | undefined;
        const trusted = Array.isArray(registered?.trusted_origins) ? registered.trusted_origins.map(String) : [];
        await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: manifest.name,
            distribution: manifest.distribution,
            trusted_origins: [...new Set([...trusted, ...executionOrigins(manifest)])],
          }),
        });
      }
      const pushed = await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}/versions`, {
        method: 'POST', body: JSON.stringify({ manifest }),
      });
      console.log(`Saved ${extensionId}@${String((pushed.data.version as Json)?.version ?? manifest.version)} as draft`);
      return 0;
    }
    if (command === 'promote') {
      const version = args[1];
      if (!version || version.startsWith('-')) throw new Error('promote requires a version');
      const promoted = await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}/versions/${encodeURIComponent(version)}/publish`, { method: 'POST' });
      console.log(`${extensionId}@${version}: ${String((promoted.data.version as Json)?.status ?? 'published')}`);
      return 0;
    }
    if (command === 'install') {
      const siteId = option(args, '--site');
      if (!siteId) throw new Error('install requires --site <site-id>');
      const configPath = option(args, '--config');
      const config = configPath ? await readJson(configPath) : {};
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as Json[] : [];
      if (manifest.distribution === 'private') {
        const current = await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}`);
        const registered = current.data.extension as Json | undefined;
        const allowed = Array.isArray(registered?.allowed_site_ids) ? registered.allowed_site_ids.map(String) : [];
        if (!allowed.includes(siteId)) {
          await api(`/api/developer/extensions/${encodeURIComponent(extensionId)}`, {
            method: 'PATCH', body: JSON.stringify({ allowed_site_ids: [...allowed, siteId] }),
          });
        }
      }
      const installed = await api(`/api/v1/sites/${encodeURIComponent(siteId)}/extensions`, {
        method: 'POST',
        body: JSON.stringify({
          extension_id: extensionId,
          version: manifest.version,
          granted_scopes: permissions.map((permission) => permission.scope).filter((scope) => typeof scope === 'string'),
          config,
        }),
      });
      console.log(`Installed ${extensionId}@${String(manifest.version)} as ${String((installed.data.installation as Json)?.id ?? '')}`);
      return 0;
    }
    help();
    return 1;
  } catch (error) {
    console.error(`typeroll extension: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
