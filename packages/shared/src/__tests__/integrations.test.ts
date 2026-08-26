/**
 * The integrations catalog.
 *
 * The security claim this app rests on: the customer supplies an IDENTIFIER
 * and the platform supplies the snippet. That only holds if the identifier is
 * validated before it's interpolated into a `<script>` body — otherwise the
 * app is just `scripts_head` with extra steps.
 */
import { describe, it, expect } from 'vitest';
import {
  INTEGRATION_PROVIDERS,
  getIntegrationProvider,
  integrationConfigKey,
  renderIntegrationTags,
} from '../integrations';

const cfg = (providerId: string, fields: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [integrationConfigKey(providerId, k), v]),
  );

describe('catalog integrity', () => {
  it('has unique provider ids', () => {
    const ids = INTEGRATION_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every provider at least one field with an anchored pattern', () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(p.fields.length, p.id).toBeGreaterThan(0);
      for (const f of p.fields) {
        // Unanchored patterns match substrings, which would let a valid-looking
        // prefix carry arbitrary trailing characters into the script body.
        expect(f.pattern.source.startsWith('^'), `${p.id}.${f.key}`).toBe(true);
        expect(f.pattern.source.endsWith('$'), `${p.id}.${f.key}`).toBe(true);
      }
    }
  });

  it('classifies every provider into a consent category, and none as necessary', () => {
    // Nothing in this catalog is strictly necessary to operate the site —
    // they're analytics, ads and support widgets. If a provider ever lands in
    // `necessary` it bypasses the consent gate, so that should be a decision
    // someone makes on purpose rather than a default.
    for (const p of INTEGRATION_PROVIDERS) {
      expect(['functional', 'analytics', 'marketing'], p.id).toContain(p.consent_category);
    }
  });

  it('treats Google Tag Manager as marketing, not analytics', () => {
    // GTM is a container that can load ad tags, so it takes the strictest
    // category rather than the one its name suggests.
    expect(getIntegrationProvider('google_tag_manager')!.consent_category).toBe('marketing');
  });
});

describe('renderIntegrationTags', () => {
  it('emits nothing without config', () => {
    expect(renderIntegrationTags(undefined).emitted).toEqual([]);
    expect(renderIntegrationTags({}).emitted).toEqual([]);
  });

  it('emits a provider whose id validates', () => {
    const out = renderIntegrationTags(cfg('google_analytics', { measurement_id: 'G-ABC1234567' }));
    expect(out.emitted).toEqual(['google_analytics']);
    expect(out.headConsent).toContain('G-ABC1234567');
    expect(out.headConsent).toContain('googletagmanager.com/gtag/js');
  });

  it('DROPS a provider whose id fails its pattern', () => {
    // The whole security argument: a value that doesn't look like an ID never
    // reaches the script body. Half-emitting would be worse than nothing.
    const out = renderIntegrationTags(
      cfg('google_analytics', { measurement_id: "G-X'; fetch('//evil'); //" }),
    );
    expect(out.emitted).toEqual([]);
    expect(out.headConsent).toBe('');
  });

  it('drops a multi-field provider when only some fields are valid', () => {
    const out = renderIntegrationTags({
      ...cfg('matomo', { url: 'https://analytics.example.com', site_id: 'not-a-number' }),
    });
    expect(out.emitted).toEqual([]);
  });

  it('emits a multi-field provider when all fields validate', () => {
    const out = renderIntegrationTags(
      cfg('matomo', { url: 'https://analytics.example.com', site_id: '7' }),
    );
    expect(out.emitted).toEqual(['matomo']);
    expect(out.headConsent).toContain('analytics.example.com');
  });

  it('rejects a non-https Matomo URL', () => {
    const out = renderIntegrationTags(
      cfg('matomo', { url: 'http://analytics.example.com', site_id: '7' }),
    );
    expect(out.emitted).toEqual([]);
  });

  it('splits head from body-end by the provider’s declared placement', () => {
    const out = renderIntegrationTags({
      ...cfg('meta_pixel', { pixel_id: '123456789012345' }),   // head
      ...cfg('hubspot', { portal_id: '1234567' }),             // body_end
    });
    expect(out.emitted).toEqual(['meta_pixel', 'hubspot']);
    expect(out.headConsent).toContain('fbevents.js');
    expect(out.headConsent).not.toContain('hs-scripts.com');
    expect(out.bodyEndConsent).toContain('hs-scripts.com');
  });

  it('routes consent-requiring tags to the *Consent buckets, never the plain ones', () => {
    // The plain buckets are emitted unconditionally by BaseLayout; anything
    // landing there would fire before the visitor answered the banner.
    const out = renderIntegrationTags({
      ...cfg('meta_pixel', { pixel_id: '123456789012345' }),
      ...cfg('intercom', { app_id: 'abcd1234' }),
      ...cfg('plausible', { domain: 'example.com' }),
    });
    expect(out.emitted.length).toBe(3);
    expect(out.head).toBe('');
    expect(out.bodyEnd).toBe('');
  });

  it('ignores a config key that is not a catalog field', () => {
    const out = renderIntegrationTags({ some_unknown_key: '<script>alert(1)</script>' });
    expect(out.emitted).toEqual([]);
    expect(out.head + out.headConsent + out.bodyEnd + out.bodyEndConsent).toBe('');
  });

  it('trims surrounding whitespace before validating', () => {
    const out = renderIntegrationTags(cfg('plausible', { domain: '  example.com  ' }));
    expect(out.emitted).toEqual(['plausible']);
    expect(out.headConsent).toContain('data-domain="example.com"');
  });

  it('never emits a raw </script> from an id value', () => {
    for (const p of INTEGRATION_PROVIDERS) {
      const evil = Object.fromEntries(p.fields.map((f) => [f.key, '</script><img src=x onerror=alert(1)>']));
      const out = renderIntegrationTags(cfg(p.id, evil));
      expect(out.emitted, p.id).toEqual([]);
    }
  });
});
