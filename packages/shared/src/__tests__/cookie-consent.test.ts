import { describe, expect, it } from 'vitest';
import { renderCookieConsent } from '../cookie-consent';

describe('renderCookieConsent', () => {
  it('renders one complete, consent-gated fragment', () => {
    const html = renderCookieConsent({
      enabled: true,
      privacy_policy_url: '/privacy/?a=1&b=2',
      scripts_necessary: '<script>window.necessary=true</script>',
      scripts_optional: '<script>window.optional=true</script>',
    }, '<p>Configured copy</p>');

    expect(html).toContain('id="tr-consent"');
    expect(html).toContain('<p>Configured copy</p>');
    expect(html).toContain('href="/privacy/?a=1&amp;b=2"');
    expect(html).toContain('<script>window.necessary=true</script>');
    expect(html).toContain('type="text/plain" data-tr-consent="optional"');
    expect(html).toContain('data-cookie-consent-runtime="1"');
  });

  it('renders nothing when disabled', () => {
    expect(renderCookieConsent({ enabled: false })).toBe('');
    expect(renderCookieConsent(undefined)).toBe('');
  });
});
