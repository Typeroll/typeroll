import { describe, expect, it } from 'vitest';
import { cookieConsentLanguage, renderCookieConsent } from '../cookie-consent';

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

  it('keeps the Swedish wording for Swedish pages', () => {
    const html = renderCookieConsent({ enabled: true, privacy_policy_url: '/integritet/' }, undefined, 'sv-SE');
    for (const text of ['Cookies på den här webbplatsen', '>Neka<', '>Endast nödvändiga<', '>Godkänn alla<', 'Läs vår integritetspolicy →', 'aria-label="Hantera cookie-inställningar"', 'Vi använder cookies']) {
      expect(html).toContain(text);
    }
  });

  it('follows the page language for German and other markets', () => {
    const german = renderCookieConsent({ enabled: true, privacy_policy_url: '/datenschutz/' }, undefined, 'de-AT');
    for (const text of ['Cookies auf dieser Website', '>Ablehnen<', '>Nur notwendige<', '>Alle akzeptieren<', 'Datenschutzerklärung lesen →', 'aria-label="Cookie-Einstellungen verwalten"', 'Wir verwenden Cookies']) {
      expect(german).toContain(text);
    }
    expect(german).not.toMatch(/Neka|Godkänn|webbplatsen|integritetspolicy/);

    const english = renderCookieConsent({ enabled: true }, undefined, 'fr');
    expect(english).toContain('>Accept all<');
    expect(english).not.toMatch(/Neka|Ablehnen/);
    expect(cookieConsentLanguage(undefined)).toBe('en');
    expect(cookieConsentLanguage('DE')).toBe('de');
    expect(cookieConsentLanguage('svenska')).toBe('en');
  });

  it('uses escaped site labels and falls back for blank ones', () => {
    const html = renderCookieConsent({
      enabled: true,
      privacy_policy_url: '/p/',
      labels: { title: 'Kekse <b>', reject: '  ', accept_all: 'Alle "ok"', privacy_link: 'Datenschutz', manage: 'Einstellungen' },
    }, '<p>Eigener Text</p>', 'de-AT');
    expect(html).toContain('>Kekse &lt;b&gt;</h2>');
    expect(html).toContain('>Ablehnen<');
    expect(html).toContain('>Alle &quot;ok&quot;<');
    expect(html).toContain('>Datenschutz</a>');
    expect(html).toContain('aria-label="Einstellungen"');
    expect(html).toContain('<p>Eigener Text</p>');
  });
});
