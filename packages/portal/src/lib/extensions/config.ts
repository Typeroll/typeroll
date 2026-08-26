import type {
  ExtensionInstallation,
  ExtensionJsonSchemaProperty,
  ExtensionObjectSchema,
} from '@typeroll/shared';
import { decryptSecret, encryptSecret, SECRET_MASK } from '../secret-crypto';

export interface ExtensionConfigState {
  public_config: Record<string, unknown>;
  private_config: Record<string, unknown>;
  secret_config_enc: Record<string, string>;
}

function accepts(property: ExtensionJsonSchemaProperty, value: unknown): boolean {
  if (property.enum && !property.enum.some((entry) => entry === value)) return false;
  switch (property.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

export function buildExtensionConfig(
  schema: ExtensionObjectSchema | undefined,
  incoming: Record<string, unknown>,
  existing?: Pick<ExtensionInstallation, 'public_config' | 'private_config' | 'secret_config_enc'>,
): ExtensionConfigState | string {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const publicConfig: Record<string, unknown> = {};
  const privateConfig: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};

  for (const [key, property] of Object.entries(properties)) {
    const value = incoming[key];
    if (property.format === 'secret') {
      const previous = existing?.secret_config_enc?.[key];
      if (typeof value === 'string' && value && value !== SECRET_MASK) secrets[key] = encryptSecret(value);
      else if (previous) secrets[key] = previous;
      if (required.has(key) && !secrets[key]) return `${property.title ?? key} is required`;
      continue;
    }

    const previous = property.public ? existing?.public_config?.[key] : existing?.private_config?.[key];
    const resolved = value === undefined || value === '' ? previous ?? property.default : value;
    if (required.has(key) && (resolved === undefined || resolved === null || resolved === '')) {
      return `${property.title ?? key} is required`;
    }
    if (resolved === undefined) continue;
    if (!accepts(property, resolved)) return `${property.title ?? key} has an invalid value`;
    if (property.public === true) publicConfig[key] = resolved;
    else privateConfig[key] = resolved;
  }

  if (schema?.additionalProperties === true) {
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in properties)) privateConfig[key] = value;
    }
  }
  return { public_config: publicConfig, private_config: privateConfig, secret_config_enc: secrets };
}

export function maskExtensionConfig(
  schema: ExtensionObjectSchema | undefined,
  installation: Pick<ExtensionInstallation, 'public_config' | 'private_config' | 'secret_config_enc'>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    if (property.format === 'secret') output[key] = installation.secret_config_enc?.[key] ? SECRET_MASK : '';
    else output[key] = property.public ? installation.public_config[key] : installation.private_config?.[key];
  }
  return output;
}

export function resolveExtensionConfig(
  installation: Pick<ExtensionInstallation, 'public_config' | 'private_config' | 'secret_config_enc'>,
): Record<string, unknown> {
  const output = { ...installation.private_config, ...installation.public_config };
  for (const [key, encrypted] of Object.entries(installation.secret_config_enc ?? {})) {
    output[key] = decryptSecret(encrypted);
  }
  return output;
}
