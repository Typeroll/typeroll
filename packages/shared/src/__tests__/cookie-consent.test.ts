import { describe, expect, it } from 'vitest';
import { cookieConsentLanguage, cookieConsentManageButtonError, cookieReopenLinkWarning, hasCookieReopenControl, renderCookieConsent } from '../cookie-consent';

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

    const english = renderCookieConsent({ enabled: true }, undefined, 'cy');
    expect(english).toContain('>Accept all<');
    expect(english).not.toMatch(/Neka|Ablehnen/);
    const czech = renderCookieConsent({ enabled: true }, undefined, 'cs-CZ');
    expect(czech).not.toContain('>Accept all<');
    expect(cookieConsentLanguage('zh-TW')).toBe('zh-Hant');
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

  it('renders the floating reopen button by default and for "floating"', () => {
    for (const version of [1, 16, 17]) {
      const base = renderCookieConsent({ enabled: true }, undefined, 'en', { renderVersion: version });
      expect(renderCookieConsent({ enabled: true, manage_button: 'floating' }, undefined, 'en', { renderVersion: version })).toBe(base);
      expect(base).toContain('<button type="button" class="tr-consent__manage" data-tr-open-consent aria-label="Manage cookie settings">');
      expect(base).toContain('.tr-consent__manage{appearance:none;');
    }
  });

  it('leaves out the floating button and its CSS for "none"', () => {
    for (const version of [1, 16, 17]) {
      const base = renderCookieConsent({ enabled: true }, undefined, 'en', { renderVersion: version });
      const html = renderCookieConsent({ enabled: true, manage_button: 'none' }, undefined, 'en', { renderVersion: version });
      expect(html).not.toContain('class="tr-consent__manage"');
      expect(html).not.toMatch(/\.tr-consent__manage[{:\s]/);
      expect(html).not.toContain('>Cookies</span>');
      // The banner and its runtime are otherwise unchanged.
      expect(html).toContain('id="tr-consent"');
      expect(html).toContain('data-cookie-consent-runtime="1"');
      expect(html).toContain('.tr-consent__panel{');
      const withoutButton = base
        .replace(/<button type="button" class="tr-consent__manage"[\s\S]*?<\/button>\n/, '')
        .split('\n').filter(line => !line.includes('.tr-consent__manage')).join('\n');
      expect(html.split('\n').filter(line => !line.includes('.tr-consent__manage')).join('\n')).toBe(withoutButton);
    }
  });
});

describe('cookie_consent.manage_button', () => {
  it('accepts floating, none and null only', () => {
    expect(cookieConsentManageButtonError(undefined)).toBeNull();
    expect(cookieConsentManageButtonError(null)).toBeNull();
    expect(cookieConsentManageButtonError('floating')).toBeNull();
    expect(cookieConsentManageButtonError('none')).toBeNull();
    for (const value of ['hidden', '', 'None', false, 0, {}]) {
      expect(cookieConsentManageButtonError(value)).toBe('cookie_consent.manage_button must be one of: floating, none');
    }
  });

  it('finds reopen links in partial HTML, block data and menus', () => {
    expect(hasCookieReopenControl([])).toBe(false);
    expect(hasCookieReopenControl([{ html_content: '<a href="#cookie-settings">Cookie settings</a>' }])).toBe(true);
    expect(hasCookieReopenControl([{ blocks: [{ type: 'core/navigation_links', data: { links: [{ label: 'Cookies', href: '#cookie-settings' }] } }] }])).toBe(true);
    expect(hasCookieReopenControl([{ items: [{ type: 'url', href: '/privacy/#cookie-settings' }] }])).toBe(true);
    expect(hasCookieReopenControl([{ html_content: '<button data-tr-open-consent>Cookies</button>' }])).toBe(true);
    expect(hasCookieReopenControl([{ html_content: '<a href="#cookie-settings-old">x</a><a href="/privacy/">Privacy</a>' }])).toBe(false);
  });

  it('warns only for an enabled banner without the button and without a reopen link', () => {
    const footer = { html_content: '<a href="#cookie-settings">Cookie settings</a>' };
    expect(cookieReopenLinkWarning({ enabled: true, manage_button: 'none' }, [])).toMatch(/^cookie_reopen_link_missing: /);
    expect(cookieReopenLinkWarning({ enabled: true, manage_button: 'none' }, [footer])).toBeNull();
    expect(cookieReopenLinkWarning({ enabled: true }, [])).toBeNull();
    expect(cookieReopenLinkWarning({ enabled: true, manage_button: 'floating' }, [])).toBeNull();
    expect(cookieReopenLinkWarning({ enabled: false, manage_button: 'none' }, [])).toBeNull();
    expect(cookieReopenLinkWarning(undefined, [])).toBeNull();
  });
});

