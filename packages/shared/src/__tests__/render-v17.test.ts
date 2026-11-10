import { describe, expect, it } from 'vitest';
import { COOKIE_CONSENT_SHIELD_CSS, renderCookieConsent } from '../cookie-consent.js';
import { LATEST_RENDER_VERSION, isRenderVersion } from '../render-version.js';

describe('render version 17', () => {
  const consent = { enabled: true } as never;

  it('is a known render version', () => {
    expect(isRenderVersion(17)).toBe(true);
    expect(LATEST_RENDER_VERSION).toBeGreaterThanOrEqual(17);
  });

  it('shields the cookie banner from bare element rules after its layered styles', () => {
    const html = renderCookieConsent(consent, undefined, 'en', { renderVersion: 17 });
    const layer = html.indexOf('@layer typeroll.base{');
    const shield = html.indexOf(COOKIE_CONSENT_SHIELD_CSS);
    expect(layer).toBeGreaterThan(-1);
    expect(shield).toBeGreaterThan(layer);
    // The shield is unlayered: it follows the closing brace of the layer block.
    expect(html.slice(shield - 2, shield)).toMatch(/}\s/);
  });

  it('keeps one-element specificity, so class rules for the banner still win', () => {
    for (const selector of COOKIE_CONSENT_SHIELD_CSS.replace(/\{.*$/, '').split(/,(?![^(]*\))/)) {
      expect(selector).not.toMatch(/#/);
      // Classes sit only inside :where(), which adds no specificity.
      expect(selector.replace(/:where\([^)]*\)/g, '')).not.toMatch(/\./);
    }
  });

  it('leaves render version 16 and older banners as they were', () => {
    expect(renderCookieConsent(consent, undefined, 'en', { renderVersion: 16 })).not.toContain('revert-layer');
    expect(renderCookieConsent(consent, undefined, 'en')).not.toContain('revert-layer');
  });
});

describe('render version 17 cookie banner buttons', () => {
  it('give the buttons a valid font declaration from version 17 only', () => {
    const consent = { enabled: true } as never;
    expect(renderCookieConsent(consent, undefined, 'en', { renderVersion: 17 })).toContain('font-family:inherit;font-size:.9375rem;font-weight:600;line-height:1.2');
    expect(renderCookieConsent(consent, undefined, 'en', { renderVersion: 16 })).toContain('font:600 .9375rem/1.2 inherit');
  });
});
