import { describe, expect, it } from 'vitest';
import { extensionMetadataUpdate, validateExtensionManifestShape } from '../src/extension-cli';

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
});
