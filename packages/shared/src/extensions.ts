import type { FieldDefinition, SharePermission } from './types.js';

export const EXTENSION_MANIFEST_SCHEMA_VERSION = 3 as const;
export const EXTENSION_RUNTIME_VERSION = '0.39.1';
export const EXTENSION_HOST_PROTOCOL_VERSION = 3 as const;

export type ExtensionDistribution = 'private' | 'unlisted' | 'public';
export type ExtensionStatus = 'active' | 'suspended';
export type ExtensionVersionStatus =
  | 'draft'
  | 'review'
  | 'published'
  | 'deprecated'
  | 'revoked';
export type ExtensionInstallationStatus =
  | 'pending'
  | 'enabled'
  | 'disabled'
  | 'revoked'
  | 'uninstalling';
export type ExtensionRenderMode = 'bundled_component' | 'embedded_app';

export type ExtensionScope =
  | 'content:read'
  | 'content:write'
  | 'collections:read'
  | 'collections:write'
  | 'forms:read'
  | 'forms:submit'
  | 'forms:write'
  | 'submissions:read'
  | 'media:read'
  | 'media:write'
  | 'deploy:request'
  | 'extension:config:read';

export interface ExtensionScopeDefinition {
  scope: ExtensionScope;
  minimum_permission: SharePermission;
  sensitive: boolean;
  description: string;
}

export const EXTENSION_SCOPE_REGISTRY: Readonly<Record<ExtensionScope, ExtensionScopeDefinition>> = {
  'content:read': { scope: 'content:read', minimum_permission: 'read', sensitive: false, description: 'Read site content.' },
  'content:write': { scope: 'content:write', minimum_permission: 'write', sensitive: true, description: 'Change site content.' },
  'collections:read': { scope: 'collections:read', minimum_permission: 'read', sensitive: false, description: 'Read collections and items.' },
  'collections:write': { scope: 'collections:write', minimum_permission: 'write', sensitive: true, description: 'Change collections and items.' },
  'forms:read': { scope: 'forms:read', minimum_permission: 'read', sensitive: false, description: 'Read form definitions.' },
  'forms:submit': { scope: 'forms:submit', minimum_permission: 'read', sensitive: false, description: 'Submit to explicitly bound forms.' },
  'forms:write': { scope: 'forms:write', minimum_permission: 'admin', sensitive: true, description: 'Create and change forms.' },
  'submissions:read': { scope: 'submissions:read', minimum_permission: 'admin', sensitive: true, description: 'Read submitted form data.' },
  'media:read': { scope: 'media:read', minimum_permission: 'read', sensitive: false, description: 'Read media metadata.' },
  'media:write': { scope: 'media:write', minimum_permission: 'write', sensitive: true, description: 'Upload and change media.' },
  'deploy:request': { scope: 'deploy:request', minimum_permission: 'admin', sensitive: true, description: 'Request a site deployment.' },
  'extension:config:read': { scope: 'extension:config:read', minimum_permission: 'admin', sensitive: true, description: 'Read this installation configuration.' },
};

export interface ExtensionPermissionRequest {
  scope: ExtensionScope;
  reason: string;
}

export interface ExtensionJsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  enum?: Array<string | number | boolean>;
  /** Display labels corresponding 1:1 with `enum`. Values remain stable. */
  enum_labels?: string[];
  format?: 'secret' | 'url' | 'email';
  title?: string;
  description?: string;
  default?: unknown;
  public?: boolean;
  properties?: Record<string, ExtensionJsonSchemaProperty>;
  required?: string[];
  items?: ExtensionJsonSchemaProperty;
}

export interface ExtensionObjectSchema {
  type: 'object';
  properties?: Record<string, ExtensionJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ExtensionUrlInput {
  name: string;
  /** Zero-based pathname segment for path inputs; negative indexes count from the end. */
  segment?: number;
  expose_as?: string;
  sensitive?: boolean;
  consume?: boolean;
  max_length?: number;
  pattern?: string;
}

export interface ExtensionRawQueryInput extends Omit<ExtensionUrlInput, 'name'> {
  name?: string;
}

export interface ExtensionUrlContextDeclaration {
  query?: ExtensionUrlInput[];
  fragment?: ExtensionUrlInput[];
  path?: ExtensionUrlInput[];
  raw_query?: ExtensionRawQueryInput;
}

export interface ExtensionBundledEntry {
  script_url: string;
  script_sha256: string;
  style_url?: string;
  style_sha256?: string;
}

export interface ExtensionEmbeddedEntry {
  frame_url: string;
  frame_origin?: string;
  sandbox?: Array<'allow-forms' | 'allow-modals' | 'allow-popups' | 'allow-downloads'>;
}

export interface ExtensionFormBinding {
  /** Stable component-local name used by context.forms.submit(). */
  id: string;
  /** Existing Forms module document on the installation's site. */
  form_id: string;
}

export interface ExtensionFrontendComponent {
  id: string;
  label: string;
  category?: string;
  icon?: string;
  description?: string;
  render_mode: ExtensionRenderMode;
  props_schema?: ExtensionObjectSchema;
  url_context?: ExtensionUrlContextDeclaration;
  form_bindings?: ExtensionFormBinding[];
  entry: ExtensionBundledEntry | ExtensionEmbeddedEntry;
  unavailable_message?: string;
}

export interface ExtensionAdminPage {
  id: string;
  label: string;
  icon?: string;
  launch_url: string;
  minimum_permission: SharePermission;
}

export type ExtensionApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ExtensionApiRoute {
  path: string;
  methods: ExtensionApiMethod[];
  /**
   * Exact subset of methods that may be called from an isolated preview.
   * Omitted means the route is unavailable in preview. Providers must enforce
   * the preview_routes claim in the short-lived installation proof too.
   */
  preview_methods?: ExtensionApiMethod[];
}

export interface ExtensionApi {
  /** Provider-owned API origin. Typeroll never proxies requests to it. */
  base_url: string;
  /** Client-side contract only; the provider must enforce authorization. */
  routes: ExtensionApiRoute[];
  /**
   * signed_installation adds a short-lived issuer JWT to direct browser
   * requests. none leaves authentication entirely to the provider.
   */
  authentication?: 'signed_installation' | 'none';
}

export type ExtensionLifecycleEvent =
  | 'extension.installed'
  | 'extension.updated'
  | 'extension.disabled'
  | 'extension.uninstalled'
  | 'extension.credential_rotated';

export interface ExtensionManifest {
  schema_version: typeof EXTENSION_MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  runtime_compatibility: string;
  distribution: ExtensionDistribution;
  developer: {
    name: string;
    support_url: string;
    privacy_url: string;
  };
  permissions: ExtensionPermissionRequest[];
  auth?: {
    /** Provider endpoint used for an explicit self-host issuer pairing. */
    pairing_url?: string;
  };
  config_schema?: ExtensionObjectSchema;
  frontend?: { components: ExtensionFrontendComponent[] };
  admin?: { pages: ExtensionAdminPage[] };
  api?: ExtensionApi;
  events?: {
    subscriptions: ExtensionLifecycleEvent[];
    webhook_url?: string;
    secret_config_key?: string;
  };
  data_handling?: {
    personal_data: boolean;
    data_location?: string;
    retention_url?: string;
  };
}

export interface Extension {
  id: string;
  developer_org_id: string;
  name: string;
  distribution: ExtensionDistribution;
  status: ExtensionStatus;
  allowed_org_ids?: string[];
  allowed_site_ids?: string[];
  client_id: string;
  client_secret_hash?: string;
  trusted_origins: string[];
  created_at: string;
  updated_at: string;
}

export interface ExtensionVersion {
  id: string;
  extension_id: string;
  version: string;
  schema_version: number;
  manifest: ExtensionManifest;
  manifest_sha256: string;
  status: ExtensionVersionStatus;
  compatibility: string;
  published_at?: string;
  deprecated_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  created_at: string;
  created_by: string;
}

export interface ExtensionInstallation {
  id: string;
  extension_id: string;
  developer_org_id: string;
  /** Release selected when the timeless connection was first approved. */
  initial_version?: string;
  /** Current control-plane release pointer; runtime resolution is authoritative. */
  version: string;
  release_policy?: 'automatic';
  owner_org_id: string;
  site_id: string;
  status: ExtensionInstallationStatus;
  granted_scopes: ExtensionScope[];
  public_config: Record<string, unknown>;
  private_config?: Record<string, unknown>;
  secret_config_enc?: Record<string, string>;
  installed_by: string;
  installed_at: string;
  updated_at: string;
  disabled_at?: string;
  last_health_at?: string;
  last_health_status?: 'healthy' | 'degraded' | 'unavailable';
  previous_version?: string;
}

export interface InstallationCredential {
  id: string;
  installation_id: string;
  prefix: string;
  secret_hash: string;
  scopes: ExtensionScope[];
  created_at: string;
  expires_at?: string;
  grace_until?: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface ExtensionLaunchGrant {
  id: string;
  code_hash: string;
  extension_id: string;
  installation_id: string;
  owner_org_id: string;
  site_id: string;
  user_id: string;
  permission: SharePermission;
  scopes: ExtensionScope[];
  audience: string;
  issued_at: string;
  expires_at: string;
  used_at?: string;
}

export interface ExtensionAuditEvent {
  id: string;
  extension_id: string;
  installation_id?: string;
  site_id?: string;
  action: string;
  actor_id?: string;
  created_at: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ExtensionEventDelivery {
  id: string;
  event_id: string;
  installation_id: string;
  event_type: ExtensionLifecycleEvent;
  attempt: number;
  status: 'pending' | 'delivered' | 'retrying' | 'failed';
  response_class?: string;
  next_attempt_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TrustedExtensionIssuer {
  id: string;
  extension_id: string;
  issuer: string;
  jwks_uri: string;
  jwks_fingerprint: string;
  status: 'pending' | 'trusted' | 'revoked';
  nonce_hash?: string;
  paired_at?: string;
  created_at: string;
}

export interface ExtensionCatalogEntry {
  id: string;
  extension_id: string;
  developer_org_id: string;
  version: string;
  name: string;
  developer_name: string;
  description?: string;
  icon?: string;
  support_url: string;
  privacy_url: string;
  permissions: ExtensionPermissionRequest[];
  data_handling?: ExtensionManifest['data_handling'];
  manifest_sha256: string;
  status: 'in_review' | 'published' | 'rejected' | 'withdrawn';
  submitted_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  review_note?: string;
}

export interface PublicExtensionComponent extends ExtensionFrontendComponent {
  block_type_id: string;
  local_script_url?: string;
  local_style_url?: string;
  resolved_form_bindings?: Record<string, PublicExtensionFormBinding>;
}

export interface PublicExtensionFormBinding extends ExtensionFormBinding {
  submit_url: string;
  submit_token: string | null;
  pow_bits: number;
}

export interface PublicExtensionInstallation {
  installation_id: string;
  extension_id: string;
  version: string;
  /** True only for request-time isolated previews, never deployed snapshots. */
  preview?: true;
  public_config: Record<string, unknown>;
  api?: {
    base_url: string;
    routes: ExtensionApiRoute[];
    authentication: 'signed_installation' | 'none';
    token_url?: string;
    /** Preview-only five-minute proof embedded in an opaque-origin preview.
     *  Never persisted in a deploy snapshot. */
    preview_token?: string;
  };
  components: PublicExtensionComponent[];
}

export interface ExtensionRuntimeSnapshot {
  runtime_version: string;
  protocol_version: number;
  installations: PublicExtensionInstallation[];
}

/** Request-local host information. It is supplied by preview rendering and
 * is never persisted in a deployed Extension snapshot. */
export interface ExtensionRuntimeHostConfig {
  site_navigation?: {
    /** Prefix that keeps a root-relative site path inside the preview. */
    base_path: string;
    /** Authentication/mode query string carried to the next preview page. */
    suffix?: string;
  };
  /** Parent shell that owns private, tab-scoped storage for an opaque preview. */
  preview_bridge?: {
    id: string;
    parent_origin: string;
  };
}

export interface ExtensionUrlCapture {
  values: Record<string, string>;
  consumed_query: string[];
  consumed_fragment: string[];
  consumed_raw_query: boolean;
  presence: Record<string, { source: 'query' | 'fragment' | 'path' | 'raw_query'; sensitive: boolean }>;
}

const PERMISSION_RANK: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };

export function effectiveExtensionScopes(
  granted: readonly ExtensionScope[],
  permission: SharePermission,
): ExtensionScope[] {
  return granted.filter((scope) => {
    const def = EXTENSION_SCOPE_REGISTRY[scope];
    return Boolean(def && PERMISSION_RANK[permission] >= PERMISSION_RANK[def.minimum_permission]);
  });
}

export interface ExtensionManifestValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: ExtensionManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return '';
  }
  return value.trim();
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) if (!known.has(key)) errors.push(`${path}.${key} is not supported by schema_version ${EXTENSION_MANIFEST_SCHEMA_VERSION}`);
}

function validatePublicHttps(value: unknown, path: string, errors: string[]): string {
  const raw = requireString(value, path, errors);
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') errors.push(`${path} must use HTTPS`);
    if (url.username || url.password) errors.push(`${path} must not contain credentials`);
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === '0.0.0.0' || host === '127.0.0.1' || host === '::1' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
    ) errors.push(`${path} must use a public host`);
  } catch {
    errors.push(`${path} must be an absolute URL`);
  }
  return raw;
}

function validateDigest(value: unknown, path: string, errors: string[]): string {
  const digest = requireString(value, path, errors);
  if (digest && !/^(?:[a-f0-9]{64}|sha256-[A-Za-z0-9_-]{43})$/i.test(digest)) {
    errors.push(`${path} must be a SHA-256 hex or SRI digest`);
  }
  return digest;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

export function isRuntimeCompatible(range: string, runtime = EXTENSION_RUNTIME_VERSION): boolean {
  const current = parseSemver(runtime);
  if (!current) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) return false;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!match) return false;
    const target = parseSemver(match[2]!);
    if (!target) return false;
    const cmp = compareSemver(current, target);
    switch (match[1] ?? '=') {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      case '^': return current[0] === target[0] && cmp >= 0;
      case '~': return current[0] === target[0] && current[1] === target[1] && cmp >= 0;
      default: return cmp === 0;
    }
  });
}

function validateUrlInputs(
  declaration: ExtensionUrlContextDeclaration | undefined,
  path: string,
  errors: string[],
): void {
  if (!declaration) return;
  const exposed = new Set<string>();
  for (const source of ['query', 'fragment', 'path'] as const) {
    const inputs = declaration[source] ?? [];
    if (!Array.isArray(inputs)) {
      errors.push(`${path}.${source} must be an array`);
      continue;
    }
    inputs.forEach((input, index) => {
      if (!isRecord(input)) {
        errors.push(`${path}.${source}[${index}] must be an object`);
        return;
      }
      const name = requireString(input.name, `${path}.${source}[${index}].name`, errors);
      const exposeAs = typeof input.expose_as === 'string' ? input.expose_as : name;
      if (name && !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) errors.push(`${path}.${source}[${index}].name has an invalid format`);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(exposeAs)) errors.push(`${path}.${source}[${index}].expose_as has an invalid format`);
      if (exposed.has(exposeAs)) errors.push(`${path} exposes "${exposeAs}" more than once`);
      exposed.add(exposeAs);
      if (input.max_length !== undefined && (!Number.isInteger(input.max_length) || Number(input.max_length) < 1 || Number(input.max_length) > 8192)) {
        errors.push(`${path}.${source}[${index}].max_length must be between 1 and 8192`);
      }
      if (source === 'path' && (!Number.isInteger(input.segment) || Number(input.segment) < -64 || Number(input.segment) > 63)) {
        errors.push(`${path}.${source}[${index}].segment must be an integer between -64 and 63`);
      }
      if (input.pattern !== undefined) {
        if (String(input.pattern).length > 512) errors.push(`${path}.${source}[${index}].pattern is too long`);
        try { new RegExp(String(input.pattern)); } catch { errors.push(`${path}.${source}[${index}].pattern must be a valid regular expression`); }
      }
    });
  }
  if (declaration.raw_query !== undefined) {
    if (!isRecord(declaration.raw_query)) {
      errors.push(`${path}.raw_query must be an object`);
    } else {
      const exposeAs = typeof declaration.raw_query.expose_as === 'string'
        ? declaration.raw_query.expose_as
        : 'raw_query';
      if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(exposeAs)) errors.push(`${path}.raw_query.expose_as has an invalid format`);
      if (exposed.has(exposeAs)) errors.push(`${path} exposes "${exposeAs}" more than once`);
      if (declaration.raw_query.max_length !== undefined && (!Number.isInteger(declaration.raw_query.max_length) || Number(declaration.raw_query.max_length) < 1 || Number(declaration.raw_query.max_length) > 8192)) {
        errors.push(`${path}.raw_query.max_length must be between 1 and 8192`);
      }
      if (declaration.raw_query.pattern !== undefined) {
        if (String(declaration.raw_query.pattern).length > 512) errors.push(`${path}.raw_query.pattern is too long`);
        try { new RegExp(String(declaration.raw_query.pattern)); } catch { errors.push(`${path}.raw_query.pattern must be a valid regular expression`); }
      }
    }
  }
}

function validateConfigSchema(schemaInput: unknown, path: string, errors: string[]): Set<string> {
  const secretKeys = new Set<string>();
  if (schemaInput === undefined) return secretKeys;
  const schema = asRecord(schemaInput, path, errors);
  if (schema.type !== 'object') errors.push(`${path}.type must be object`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(`${path}.additionalProperties must be a boolean`);
  }
  const properties = schema.properties === undefined
    ? {}
    : asRecord(schema.properties, `${path}.properties`, errors);
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (schema.required !== undefined && !Array.isArray(schema.required)) errors.push(`${path}.required must be an array`);
  for (const key of required) {
    if (typeof key !== 'string' || !(key in properties)) errors.push(`${path}.required contains unknown property "${String(key)}"`);
  }
  for (const [key, propertyInput] of Object.entries(properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)) errors.push(`${path}.properties.${key} has an invalid name`);
    const property = asRecord(propertyInput, `${path}.properties.${key}`, errors);
    const allowedTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
    if (property.type !== undefined && !allowedTypes.includes(String(property.type))) {
      errors.push(`${path}.properties.${key}.type is unsupported`);
    }
    if (property.format === 'secret') {
      secretKeys.add(key);
      if (property.type !== undefined && property.type !== 'string') errors.push(`${path}.properties.${key} secrets must be strings`);
      if (property.public === true) errors.push(`${path}.properties.${key} secrets cannot be public`);
      if (property.default !== undefined) errors.push(`${path}.properties.${key} secrets cannot have defaults`);
    }
    if (property.public !== undefined && typeof property.public !== 'boolean') {
      errors.push(`${path}.properties.${key}.public must be a boolean`);
    }
    if (property.enum_labels !== undefined) {
      if (!Array.isArray(property.enum_labels) || property.enum_labels.some((label) => typeof label !== 'string')) {
        errors.push(`${path}.properties.${key}.enum_labels must be an array of strings`);
      } else if (!Array.isArray(property.enum) || property.enum_labels.length !== property.enum.length) {
        errors.push(`${path}.properties.${key}.enum_labels must have the same length as enum`);
      }
    }
    if (property.required !== undefined && (!Array.isArray(property.required) || property.required.some((name) => typeof name !== 'string'))) {
      errors.push(`${path}.properties.${key}.required must be an array of strings`);
    }
  }
  return secretKeys;
}

export function validateExtensionManifest(input: unknown): ExtensionManifestValidationResult {
  const errors: string[] = [];
  const manifest = asRecord(input, 'manifest', errors);
  rejectUnknown(manifest, [
    'schema_version', 'id', 'name', 'version', 'runtime_compatibility', 'distribution',
    'developer', 'permissions', 'auth', 'config_schema', 'frontend', 'admin',
    'api', 'events', 'data_handling',
  ], 'manifest', errors);
  if (manifest.schema_version !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${EXTENSION_MANIFEST_SCHEMA_VERSION}`);
  }
  const id = requireString(manifest.id, 'id', errors);
  if (id && !/^[a-z0-9]+(?:[.-][a-z0-9][a-z0-9-]*){2,}$/.test(id)) {
    errors.push('id must be a lowercase namespaced identifier');
  }
  requireString(manifest.name, 'name', errors);
  const version = requireString(manifest.version, 'version', errors);
  if (version && !parseSemver(version)) errors.push('version must be valid SemVer');
  const compatibility = requireString(manifest.runtime_compatibility, 'runtime_compatibility', errors);
  if (compatibility && !isRuntimeCompatible(compatibility)) {
    errors.push(`runtime_compatibility does not include ${EXTENSION_RUNTIME_VERSION}`);
  }
  if (!['private', 'unlisted', 'public'].includes(String(manifest.distribution))) {
    errors.push('distribution must be private, unlisted, or public');
  }

  const developer = asRecord(manifest.developer, 'developer', errors);
  requireString(developer.name, 'developer.name', errors);
  validatePublicHttps(developer.support_url, 'developer.support_url', errors);
  validatePublicHttps(developer.privacy_url, 'developer.privacy_url', errors);

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!Array.isArray(manifest.permissions)) errors.push('permissions must be an array');
  const requestedScopes = new Set<string>();
  permissions.forEach((entry, index) => {
    const permission = asRecord(entry, `permissions[${index}]`, errors);
    const scope = requireString(permission.scope, `permissions[${index}].scope`, errors);
    if (!(scope in EXTENSION_SCOPE_REGISTRY)) errors.push(`permissions[${index}].scope is unknown`);
    if (requestedScopes.has(scope)) errors.push(`permissions contains duplicate scope "${scope}"`);
    requestedScopes.add(scope);
    requireString(permission.reason, `permissions[${index}].reason`, errors);
  });

  const secretConfigKeys = validateConfigSchema(manifest.config_schema, 'config_schema', errors);

  const componentIds = new Set<string>();
  const components = isRecord(manifest.frontend) && Array.isArray(manifest.frontend.components)
    ? manifest.frontend.components
    : [];
  if (manifest.frontend !== undefined && (!isRecord(manifest.frontend) || !Array.isArray(manifest.frontend.components))) {
    errors.push('frontend.components must be an array');
  }
  components.forEach((entry, index) => {
    const component = asRecord(entry, `frontend.components[${index}]`, errors);
    const componentId = requireString(component.id, `frontend.components[${index}].id`, errors);
    if (componentId && !/^[a-z][a-z0-9-]{0,62}$/.test(componentId)) errors.push(`frontend.components[${index}].id has an invalid format`);
    if (componentIds.has(componentId)) errors.push(`frontend component id "${componentId}" is duplicated`);
    componentIds.add(componentId);
    requireString(component.label, `frontend.components[${index}].label`, errors);
    const mode = component.render_mode;
    if (mode !== 'bundled_component' && mode !== 'embedded_app') errors.push(`frontend.components[${index}].render_mode is invalid`);
    validateUrlInputs(component.url_context as ExtensionUrlContextDeclaration | undefined, `frontend.components[${index}].url_context`, errors);
    const formBindings = component.form_bindings === undefined
      ? []
      : Array.isArray(component.form_bindings)
        ? component.form_bindings
        : [];
    if (component.form_bindings !== undefined && !Array.isArray(component.form_bindings)) {
      errors.push(`frontend.components[${index}].form_bindings must be an array`);
    }
    const bindingIds = new Set<string>();
    formBindings.forEach((bindingInput, bindingIndex) => {
      const binding = asRecord(
        bindingInput,
        `frontend.components[${index}].form_bindings[${bindingIndex}]`,
        errors,
      );
      rejectUnknown(
        binding,
        ['id', 'form_id'],
        `frontend.components[${index}].form_bindings[${bindingIndex}]`,
        errors,
      );
      const bindingId = requireString(
        binding.id,
        `frontend.components[${index}].form_bindings[${bindingIndex}].id`,
        errors,
      );
      const formId = requireString(
        binding.form_id,
        `frontend.components[${index}].form_bindings[${bindingIndex}].form_id`,
        errors,
      );
      if (bindingId && !/^[a-z][a-z0-9_-]{0,62}$/.test(bindingId)) {
        errors.push(`frontend.components[${index}].form_bindings[${bindingIndex}].id has an invalid format`);
      }
      if (formId && !/^[a-z][a-z0-9_-]{0,62}$/.test(formId)) {
        errors.push(`frontend.components[${index}].form_bindings[${bindingIndex}].form_id has an invalid format`);
      }
      if (bindingIds.has(bindingId)) {
        errors.push(`frontend component "${componentId}" has duplicate form binding "${bindingId}"`);
      }
      bindingIds.add(bindingId);
    });
    if (formBindings.length > 0 && !requestedScopes.has('forms:submit')) {
      errors.push(`frontend component "${componentId}" requires the forms:submit permission`);
    }
    const entryData = asRecord(component.entry, `frontend.components[${index}].entry`, errors);
    if (mode === 'bundled_component') {
      validatePublicHttps(entryData.script_url, `frontend.components[${index}].entry.script_url`, errors);
      validateDigest(entryData.script_sha256, `frontend.components[${index}].entry.script_sha256`, errors);
      if (entryData.style_url !== undefined) {
        validatePublicHttps(entryData.style_url, `frontend.components[${index}].entry.style_url`, errors);
        validateDigest(entryData.style_sha256, `frontend.components[${index}].entry.style_sha256`, errors);
      }
    } else if (mode === 'embedded_app') {
      const frameUrl = validatePublicHttps(entryData.frame_url, `frontend.components[${index}].entry.frame_url`, errors);
      if (frameUrl && entryData.frame_origin) {
        try {
          if (new URL(frameUrl).origin !== String(entryData.frame_origin)) errors.push(`frontend.components[${index}].entry.frame_origin must match frame_url`);
        } catch { /* frame_url error already reported */ }
      }
    }
  });

  const pageIds = new Set<string>();
  const pages = isRecord(manifest.admin) && Array.isArray(manifest.admin.pages) ? manifest.admin.pages : [];
  if (manifest.admin !== undefined && (!isRecord(manifest.admin) || !Array.isArray(manifest.admin.pages))) errors.push('admin.pages must be an array');
  pages.forEach((entry, index) => {
    const page = asRecord(entry, `admin.pages[${index}]`, errors);
    const pageId = requireString(page.id, `admin.pages[${index}].id`, errors);
    if (pageIds.has(pageId)) errors.push(`admin page id "${pageId}" is duplicated`);
    pageIds.add(pageId);
    requireString(page.label, `admin.pages[${index}].label`, errors);
    validatePublicHttps(page.launch_url, `admin.pages[${index}].launch_url`, errors);
    if (!['read', 'write', 'admin'].includes(String(page.minimum_permission))) errors.push(`admin.pages[${index}].minimum_permission is invalid`);
  });

  if (manifest.api !== undefined) {
    const api = asRecord(manifest.api, 'api', errors);
    rejectUnknown(api, ['base_url', 'routes', 'authentication'], 'api', errors);
    validatePublicHttps(api.base_url, 'api.base_url', errors);
    if (api.authentication !== undefined && !['signed_installation', 'none'].includes(String(api.authentication))) {
      errors.push('api.authentication must be signed_installation or none');
    }
    const routes = Array.isArray(api.routes) ? api.routes : [];
    if (!Array.isArray(api.routes)) errors.push('api.routes must be an array');
    routes.forEach((entry, index) => {
      const route = asRecord(entry, `api.routes[${index}]`, errors);
      rejectUnknown(route, ['path', 'methods', 'preview_methods'], `api.routes[${index}]`, errors);
      const routePath = requireString(route.path, `api.routes[${index}].path`, errors);
      if (!routePath.startsWith('/') || routePath.includes('..') || (routePath.includes('*') && !routePath.endsWith('/*'))) {
        errors.push(`api.routes[${index}].path must be an absolute path with an optional trailing wildcard`);
      }
      const methods = Array.isArray(route.methods) ? route.methods : [];
      if (!methods.length || methods.some((method) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method)))) {
        errors.push(`api.routes[${index}].methods contains an unsupported method`);
      }
      const previewMethods = route.preview_methods === undefined
        ? []
        : Array.isArray(route.preview_methods)
          ? route.preview_methods
          : [];
      if (route.preview_methods !== undefined && !Array.isArray(route.preview_methods)) {
        errors.push(`api.routes[${index}].preview_methods must be an array`);
      } else if (route.preview_methods !== undefined && previewMethods.length === 0) {
        errors.push(`api.routes[${index}].preview_methods must not be empty`);
      } else if (previewMethods.some((method) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method)))) {
        errors.push(`api.routes[${index}].preview_methods contains an unsupported method`);
      } else if (previewMethods.some((method) => !methods.includes(method))) {
        errors.push(`api.routes[${index}].preview_methods must be a subset of methods`);
      }
    });
  }

  if (manifest.auth !== undefined) {
    const auth = asRecord(manifest.auth, 'auth', errors);
    if (auth.pairing_url !== undefined) validatePublicHttps(auth.pairing_url, 'auth.pairing_url', errors);
  }

  if (manifest.events !== undefined) {
    const events = asRecord(manifest.events, 'events', errors);
    const subscriptions = Array.isArray(events.subscriptions) ? events.subscriptions : [];
    const allowedEvents: ExtensionLifecycleEvent[] = [
      'extension.installed', 'extension.updated', 'extension.disabled',
      'extension.uninstalled', 'extension.credential_rotated',
    ];
    if (!Array.isArray(events.subscriptions)) errors.push('events.subscriptions must be an array');
    if (subscriptions.some((event) => !allowedEvents.includes(event as ExtensionLifecycleEvent))) {
      errors.push('events.subscriptions contains an unsupported event');
    }
    if (events.webhook_url !== undefined) validatePublicHttps(events.webhook_url, 'events.webhook_url', errors);
    if (events.secret_config_key !== undefined && !secretConfigKeys.has(String(events.secret_config_key))) {
      errors.push('events.secret_config_key must reference a secret config property');
    }
    if (subscriptions.length && !events.webhook_url) errors.push('events.webhook_url is required when subscriptions are declared');
  }

  return errors.length
    ? { valid: false, errors }
    : { valid: true, errors: [], manifest: input as ExtensionManifest };
}

function readInputValue(
  input: ExtensionUrlInput | ExtensionRawQueryInput,
  value: string | null,
): string | null {
  if (value === null) return null;
  const maxLength = input.max_length ?? 4096;
  if (value.length > maxLength) return null;
  if (input.pattern) {
    try {
      if (!new RegExp(input.pattern).test(value)) return null;
    } catch {
      return null;
    }
  }
  return value;
}

function fragmentParams(url: URL): URLSearchParams {
  const raw = url.hash.replace(/^#/, '');
  return new URLSearchParams(raw);
}

export function captureExtensionUrlContext(
  declaration: ExtensionUrlContextDeclaration | undefined,
  urlInput: string | URL,
  pathValues: Record<string, string> = {},
): ExtensionUrlCapture {
  const url = typeof urlInput === 'string' ? new URL(urlInput, 'https://typeroll.invalid') : new URL(urlInput.toString());
  const values: Record<string, string> = {};
  const presence: ExtensionUrlCapture['presence'] = {};
  const consumedQuery: string[] = [];
  const consumedFragment: string[] = [];
  const fragments = fragmentParams(url);

  const capture = (source: 'query' | 'fragment' | 'path', input: ExtensionUrlInput, raw: string | null) => {
    const value = readInputValue(input, raw);
    if (value === null) return;
    const exposed = input.expose_as ?? input.name;
    values[exposed] = value;
    presence[exposed] = { source, sensitive: input.sensitive === true };
    if (input.consume) {
      if (source === 'query') consumedQuery.push(input.name);
      if (source === 'fragment') consumedFragment.push(input.name);
    }
  };

  for (const input of declaration?.query ?? []) capture('query', input, url.searchParams.get(input.name));
  for (const input of declaration?.fragment ?? []) capture('fragment', input, fragments.get(input.name));
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return ''; }
  });
  for (const input of declaration?.path ?? []) {
    const index = input.segment === undefined ? undefined : input.segment < 0 ? segments.length + input.segment : input.segment;
    capture('path', input, pathValues[input.name] ?? (index === undefined ? null : segments[index] ?? null));
  }

  let consumedRawQuery = false;
  if (declaration?.raw_query) {
    const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    let decodedRaw: string | null = null;
    if (raw && !raw.includes('=')) {
      try { decodedRaw = decodeURIComponent(raw); } catch { decodedRaw = null; }
    }
    const value = readInputValue(declaration.raw_query, decodedRaw);
    if (value !== null) {
      const exposed = declaration.raw_query.expose_as ?? declaration.raw_query.name ?? 'raw_query';
      values[exposed] = value;
      presence[exposed] = { source: 'raw_query', sensitive: declaration.raw_query.sensitive === true };
      consumedRawQuery = declaration.raw_query.consume === true;
    }
  }

  return {
    values,
    presence,
    consumed_query: consumedQuery,
    consumed_fragment: consumedFragment,
    consumed_raw_query: consumedRawQuery,
  };
}

export function urlAfterExtensionContextConsumption(urlInput: string | URL, captures: ExtensionUrlCapture[]): string {
  const url = typeof urlInput === 'string' ? new URL(urlInput, 'https://typeroll.invalid') : new URL(urlInput.toString());
  const fragments = fragmentParams(url);
  let clearRawQuery = false;
  for (const capture of captures) {
    for (const name of capture.consumed_query) url.searchParams.delete(name);
    for (const name of capture.consumed_fragment) fragments.delete(name);
    clearRawQuery ||= capture.consumed_raw_query;
  }
  if (clearRawQuery) url.search = '';
  const fragment = fragments.toString();
  url.hash = fragment ? `#${fragment}` : '';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createExtensionUrlRuntime(values: Record<string, string>) {
  const available = new Map(Object.entries(values));
  return {
    get(name: string): string | undefined {
      return available.get(name);
    },
    consume(name: string): string | undefined {
      const value = available.get(name);
      available.delete(name);
      return value;
    },
    has(name: string): boolean {
      return available.has(name);
    },
  };
}

export function createExtensionNavigation(initial = 'root') {
  let current = initial;
  const listeners = new Set<(view: string) => void>();
  return {
    get current(): string { return current; },
    navigate(view: string): void {
      if (typeof view !== 'string' || !view.trim() || view === current) return;
      current = view;
      for (const listener of listeners) listener(current);
    },
    subscribe(listener: (view: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function extensionPropsToFields(schema: ExtensionObjectSchema | undefined): FieldDefinition[] {
  const required = new Set(schema?.required ?? []);
  const fieldFor = (name: string, property: ExtensionJsonSchemaProperty, isRequired = false): FieldDefinition => {
    let type: FieldDefinition['type'] = 'text';
    if (property.type === 'boolean') type = 'boolean';
    else if (property.type === 'number' || property.type === 'integer') type = 'number';
    else if (property.format === 'url') type = 'url';
    else if (property.format === 'email') type = 'email';
    else if (property.enum?.length) type = 'select';
    else if (property.type === 'array') {
      type = property.items?.type === 'object' ? 'array' : 'list_simple';
    } else if (property.type === 'object') type = 'object';
    return {
      name,
      type,
      label: property.title ?? name.replace(/[_-]+/g, ' ').replace(/^./, (char) => char.toUpperCase()),
      required: isRequired,
      default: property.default,
      options: property.enum?.map(String),
      option_labels: property.enum_labels,
      fields: property.type === 'object'
        ? Object.entries(property.properties ?? {}).map(([childName, child]) => fieldFor(childName, child, property.required?.includes(childName)))
        : property.type === 'array' && property.items?.type === 'object'
          ? Object.entries(property.items.properties ?? {}).map(([childName, child]) => fieldFor(childName, child, property.items?.required?.includes(childName)))
          : undefined,
    };
  };
  return Object.entries(schema?.properties ?? {}).map(([name, property]) =>
    fieldFor(name, property, required.has(name)));
}
