import {
  CORE_VERSION,
  DATA_SCHEMA_READABLE_MAX,
  DATA_SCHEMA_READABLE_MIN,
  DATA_SCHEMA_VERSION,
  EXTENSION_HOST_PROTOCOL_VERSION,
  EXTENSION_RUNTIME_VERSION,
  SITE_TEMPLATE_CAPABILITIES,
} from '@typeroll/shared';
import { VERSION as MCP_VERSION } from '@typeroll/mcp-server/version';

export type ServiceRole = 'portal' | 'forms' | 'worker';

export interface ReleaseManifest {
  core_version: string;
  data_schema_version: number;
  data_schema_readable: { min: number; max: number };
  template_capabilities_version: string;
  extension_host_protocol_version: number;
  extension_runtime_version: string;
  mcp_version: string;
  source_sha: string | null;
  image_digest: string | null;
  service_role: ServiceRole;
}

function optionalValue(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function serviceRole(env: NodeJS.ProcessEnv = process.env): ServiceRole {
  const value = env.SERVICE_ROLE?.trim().toLowerCase();
  if (value === 'forms' || value === 'worker') return value;
  return 'portal';
}

export function releaseManifest(env: NodeJS.ProcessEnv = process.env): ReleaseManifest {
  return {
    core_version: CORE_VERSION,
    data_schema_version: DATA_SCHEMA_VERSION,
    data_schema_readable: {
      min: DATA_SCHEMA_READABLE_MIN,
      max: DATA_SCHEMA_READABLE_MAX,
    },
    template_capabilities_version: SITE_TEMPLATE_CAPABILITIES.template_capabilities_version,
    extension_host_protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
    extension_runtime_version: EXTENSION_RUNTIME_VERSION,
    mcp_version: MCP_VERSION,
    source_sha: optionalValue(env.TYPEROLL_SOURCE_SHA),
    image_digest: optionalValue(env.TYPEROLL_IMAGE_DIGEST),
    service_role: serviceRole(env),
  };
}
