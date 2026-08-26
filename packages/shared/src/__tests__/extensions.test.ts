import { describe, expect, it, vi } from 'vitest';
import {
  captureExtensionUrlContext,
  createExtensionNavigation,
  createExtensionUrlRuntime,
  effectiveExtensionScopes,
  isRuntimeCompatible,
  urlAfterExtensionContextConsumption,
  validateExtensionManifest,
  type ExtensionManifest,
} from '../extensions';
import { buildExtensionRuntimeScript } from '../extensions-runtime';
import { SITE_TEMPLATE_CAPABILITIES } from '../site-template-capabilities';
import quotePilotManifest from '../../../../examples/quote-extension/typeroll-extension.json';

function manifest(): ExtensionManifest {
  return {
    schema_version: 3,
    id: 'se.vendor.quote-generator',
    name: 'Quote Generator',
    version: '1.2.0',
    runtime_compatibility: '>=0.38.0 <1.0.0',
    distribution: 'private',
    developer: {
      name: 'Vendor AB',
      support_url: 'https://vendor.example/support',
      privacy_url: 'https://vendor.example/privacy',
    },
    permissions: [{ scope: 'content:read', reason: 'Reads products.' }],
    frontend: {
      components: [{
        id: 'calculator',
        label: 'Quote calculator',
        render_mode: 'bundled_component',
        props_schema: {
          type: 'object',
          properties: { heading: { type: 'string' } },
        },
        url_context: {
          fragment: [{ name: 't', expose_as: 'customer_token', sensitive: true, consume: true }],
        },
        entry: {
          script_url: 'https://cdn.vendor.example/quote/1.2.0/index.js',
          script_sha256: 'a'.repeat(64),
        },
      }],
    },
    api: {
      base_url: 'https://api.vendor.example/typeroll',
      authentication: 'signed_installation',
      routes: [{ path: '/quotes/*', methods: ['GET', 'POST'] }],
    },
  };
}

describe('extension manifest', () => {
  it('accepts a compatible immutable component contract', () => {
    const result = validateExtensionManifest(manifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps the quote pilot fixture conformant with the executable validator', () => {
    expect(validateExtensionManifest(quotePilotManifest)).toMatchObject({ valid: true, errors: [] });
  });

  it('fails closed for private API origins and unknown proxy-era fields', () => {
    const input = manifest();
    input.api!.base_url = 'http://127.0.0.1/internal';
    (input.api!.routes[0] as unknown as Record<string, unknown>).forward_headers = ['Cookie'];
    const result = validateExtensionManifest(input);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'api.base_url must use HTTPS',
      'api.base_url must use a public host',
      'api.routes[0].forward_headers is not supported by schema_version 3',
    ]));
  });

  it('rejects duplicate exposed URL names', () => {
    const input = manifest();
    input.frontend!.components[0]!.url_context!.query = [
      { name: 'quote', expose_as: 'customer_token' },
    ];
    const result = validateExtensionManifest(input);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('frontend.components[0].url_context exposes "customer_token" more than once');
  });

  it('accepts declared form bindings with the least-privilege submit scope', () => {
    const input = manifest();
    input.permissions.push({ scope: 'forms:submit', reason: 'Stores quote leads.' });
    input.frontend!.components[0]!.form_bindings = [
      { id: 'lead', form_id: 'quote-leads' },
    ];

    expect(validateExtensionManifest(input)).toMatchObject({ valid: true, errors: [] });
  });

  it('rejects undeclared, duplicated and unsafe form bindings', () => {
    const input = manifest();
    input.frontend!.components[0]!.form_bindings = [
      { id: 'lead', form_id: 'quote-leads' },
      { id: 'lead', form_id: '../other-site' },
    ];

    expect(validateExtensionManifest(input).errors).toEqual(expect.arrayContaining([
      'frontend component "calculator" has duplicate form binding "lead"',
      'frontend.components[0].form_bindings[1].form_id has an invalid format',
      'frontend component "calculator" requires the forms:submit permission',
    ]));
  });

  it('rejects secret defaults, public secrets and invalid event secret references', () => {
    const input = manifest();
    input.config_schema = {
      type: 'object',
      properties: { signing_secret: { type: 'string', format: 'secret', public: true, default: 'plaintext' } },
    };
    input.events = {
      subscriptions: ['extension.installed'],
      webhook_url: 'https://vendor.example/events',
      secret_config_key: 'missing_secret',
    };
    const result = validateExtensionManifest(input);
    expect(result.errors).toEqual(expect.arrayContaining([
      'config_schema.properties.signing_secret secrets cannot be public',
      'config_schema.properties.signing_secret secrets cannot have defaults',
      'events.secret_config_key must reference a secret config property',
    ]));
  });

  it('rejects undeclared top-level v1 fields', () => {
    const input = { ...manifest(), arbitrary_control_plane_url: 'https://evil.example' };
    expect(validateExtensionManifest(input).errors).toContain('manifest.arbitrary_control_plane_url is not supported by schema_version 3');
  });

  it('evaluates the supported compatibility range', () => {
    expect(isRuntimeCompatible('>=0.37.0 <1.0.0', '0.37.0')).toBe(true);
    expect(isRuntimeCompatible('>=0.38.0 <1.0.0', '0.37.0')).toBe(false);
    expect(isRuntimeCompatible('not-a-range', '0.37.0')).toBe(false);
  });
});

describe('extension URL context', () => {
  it('captures only declared inputs and removes consumed representations together', () => {
    const declaration = {
      query: [{ name: 'utm_source' }],
      fragment: [{ name: 't', expose_as: 'customer_token', sensitive: true, consume: true }],
    };
    const url = 'https://customer.example/quote/?utm_source=mail&ignored=secret#t=token-123&tab=terms';
    const capture = captureExtensionUrlContext(declaration, url);
    expect(capture.values).toEqual({ utm_source: 'mail', customer_token: 'token-123' });
    expect(capture.presence.customer_token).toEqual({ source: 'fragment', sensitive: true });
    expect(urlAfterExtensionContextConsumption(url, [capture])).toBe('/quote/?utm_source=mail&ignored=secret#tab=terms');
  });

  it('drops overlong or pattern-invalid values at the transport boundary', () => {
    const capture = captureExtensionUrlContext({
      query: [{ name: 't', max_length: 5, pattern: '^[a-z]+$' }],
    }, 'https://customer.example/?t=abcdef');
    expect(capture.values).toEqual({});
  });

  it('supports the legacy raw-query shape without treating named params as raw values', () => {
    const declaration = { raw_query: { expose_as: 'customer_token', consume: true } };
    const opaque = captureExtensionUrlContext(declaration, 'https://customer.example/quote/?fjEhj54723fhFhhggh');
    const named = captureExtensionUrlContext(declaration, 'https://customer.example/quote/?t=value');
    expect(opaque.values.customer_token).toBe('fjEhj54723fhFhhggh');
    expect(opaque.consumed_raw_query).toBe(true);
    expect(named.values).toEqual({});
  });

  it('captures declared pathname segments without requiring a dynamic Typeroll page route', () => {
    const capture = captureExtensionUrlContext({
      path: [{ name: 'recipient', expose_as: 'customer_token', segment: -1, sensitive: true }],
    }, 'https://customer.example/plan/demo-recipient-token');
    expect(capture.values).toEqual({ customer_token: 'demo-recipient-token' });
  });

  it('consumes a private runtime copy once while preserving navigation state', () => {
    const url = createExtensionUrlRuntime({ customer_token: 'token-123' });
    const navigation = createExtensionNavigation('summary');
    const listener = vi.fn();
    navigation.subscribe(listener);

    expect(url.consume('customer_token')).toBe('token-123');
    navigation.navigate('terms');
    navigation.navigate('approve');

    expect(url.consume('customer_token')).toBeUndefined();
    expect(navigation.current).toBe('approve');
    expect(listener.mock.calls).toEqual([['terms'], ['approve']]);
  });

  it('ships per-mount memory navigation and embedded navigation messages', () => {
    const runtime = buildExtensionRuntimeScript({
      runtime_version: '0.38.0', protocol_version: 3, installations: [],
    });
    expect(runtime).toContain('function navigation()');
    expect(runtime).toContain('typeroll.extension.navigate');
    expect(runtime).toContain('typeroll.extension.navigation');
    expect(runtime).toContain('typeroll.extension.form.submit');
    expect(runtime).toContain('typeroll.extension.form.result');
    expect(runtime).toContain('typeroll.extension.api.request');
    expect(runtime).toContain('typeroll.extension.api.result');
    expect(runtime).toContain('forms:forms(entry.descriptor.component)');
    expect(runtime).toContain('api:apiClient(entry.descriptor.installation)');
    expect(runtime).toContain('X-Typeroll-Extension-Token');
    expect(runtime).toContain('credentials:"omit"');
    expect(runtime).toContain('__TYPEROLL_EXTENSION_PATH_CONTEXT__');
    expect(() => new Function(runtime)).not.toThrow();
  });
});

describe('extension scopes', () => {
  it('intersects granted scopes with the current site permission', () => {
    const granted = ['content:read', 'content:write', 'submissions:read'] as const;
    expect(effectiveExtensionScopes(granted, 'read')).toEqual(['content:read']);
    expect(effectiveExtensionScopes(granted, 'write')).toEqual(['content:read', 'content:write']);
    expect(effectiveExtensionScopes(granted, 'admin')).toEqual([...granted]);
  });
});

describe('extension renderer capabilities', () => {
  it('advertises the executable runtime contract', () => {
    expect(SITE_TEMPLATE_CAPABILITIES).toMatchObject({
      template_capabilities_version: '0.38.0',
      supports_extension_blocks: true,
      supports_extension_html_directive: true,
      supports_direct_extension_api: true,
      supports_extension_form_bindings: true,
      extension_protocol_version: 3,
      extension_runtime_version: '0.38.0',
      extension_render_modes: ['bundled_component', 'embedded_app'],
    });
  });
});
