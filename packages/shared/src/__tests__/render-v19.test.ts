import { describe, expect, it } from 'vitest';
import { LATEST_RENDER_VERSION, RENDER_VERSIONS, isRenderVersion } from '../render-version.js';
import { COOKIE_FOOTER_LINK_RENDER_VERSION, cookieFooterLinkHtml, renderCookieConsent, withCookieFooterLink } from '../cookie-consent.js';

const FOOTER = '<footer class="site-footer"><p>© Site</p></footer>';

describe('render version 19', () => {
  it('is a known render version introduced by Core 0.3.28', () => {
    expect(isRenderVersion(19)).toBe(true);
    expect(LATEST_RENDER_VERSION).toBeGreaterThanOrEqual(19);
    expect(COOKIE_FOOTER_LINK_RENDER_VERSION).toBe(19);
    expect(RENDER_VERSIONS.find(info => info.version === 19)?.core_version).toBe('0.3.28');
  });

  it('moves the cookie banner reopen control from a floating button to the footer', () => {
    const banner = renderCookieConsent({ enabled: true }, undefined, 'sv-SE', { renderVersion: 19 });
    expect(banner).not.toContain('class="tr-consent__manage"');
    expect(withCookieFooterLink(FOOTER, { enabled: true }, { language: 'sv-SE', renderVersion: 19 }))
      .toMatch(/<p class="tr-consent-footer-link"><a href="#cookie-settings" data-tr-open-consent>Cookie-inställningar<\/a><\/p><\/footer>$/);
  });

  it('leaves render version 18 and older as they were', () => {
    for (const version of [1, 16, 18]) {
      expect(renderCookieConsent({ enabled: true }, undefined, 'en', { renderVersion: version })).toContain('class="tr-consent__manage"');
      expect(withCookieFooterLink(FOOTER, { enabled: true }, { renderVersion: version })).toBe(FOOTER);
      expect(cookieFooterLinkHtml({ enabled: true }, { renderVersion: version })).toBe('');
    }
  });
});
