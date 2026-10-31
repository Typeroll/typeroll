import { describe, expect, it } from 'vitest';
import { languageHomePath, languageSectionFor, normalizeLanguageSections, settingsForLanguage } from '../language-sections.js';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { SiteSettings } from '../types.js';

const swedish = { language: 'sv-SE', home_path: '/sv/' };

describe('normalizeLanguageSections', () => {
  it('accepts a section and canonicalizes its tag', () => {
    expect(normalizeLanguageSections([{ language: 'sv-se', home_path: '/sv/', tagline: ' Flytt ' }], 'fi')).toEqual({
      sections: [{ language: 'sv-SE', home_path: '/sv/', tagline: 'Flytt' }],
    });
  });

  it('clears with null', () => {
    expect(normalizeLanguageSections(null)).toEqual({ sections: [] });
  });

  it('rejects the site language, repeats, a root home path and unknown fields', () => {
    expect(normalizeLanguageSections([{ language: 'fi', home_path: '/fi/' }], 'fi').error).toMatch(/site language/);
    expect(normalizeLanguageSections([swedish, { language: 'sv-SE', home_path: '/se/' }]).error).toMatch(/repeats sv-SE/);
    expect(normalizeLanguageSections([swedish, { language: 'en', home_path: '/SV/' }]).error).toMatch(/home_path repeats/);
    expect(normalizeLanguageSections([{ language: 'sv', home_path: '/' }]).error).toMatch(/home_path/);
    expect(normalizeLanguageSections([{ language: 'sv', home_path: '/sv' }]).error).toMatch(/home_path/);
    expect(normalizeLanguageSections([{ ...swedish, menu: [] }]).error).toMatch(/Unknown language_sections\[0\] fields: menu/);
    expect(normalizeLanguageSections([{ language: 'x-default', home_path: '/x/' }]).error).toMatch(/language/);
  });

  it('validates banner wording like the site-wide banner', () => {
    const ok = normalizeLanguageSections([{ ...swedish, cookie_consent: { text: '<p>Vi använder kakor.</p>', privacy_policy_url: '/sv/cookies/', labels: { accept_all: 'Godkänn' } } }]);
    expect(ok.sections?.[0].cookie_consent).toEqual({ text: '<p>Vi använder kakor.</p>', privacy_policy_url: '/sv/cookies/', labels: { accept_all: 'Godkänn' } });
    expect(normalizeLanguageSections([{ ...swedish, cookie_consent: { privacy_policy_url: 'javascript:alert(1)' } }]).error).toMatch(/privacy_policy_url/);
    expect(normalizeLanguageSections([{ ...swedish, cookie_consent: { scripts_optional: '<script>' } }]).error).toMatch(/Unknown/);
    expect(normalizeLanguageSections([{ ...swedish, cookie_consent: { labels: { title: 'x'.repeat(121) } } }]).error).toMatch(/at most 120/);
  });
});

describe('languageSectionFor', () => {
  it('matches the exact tag first, then the primary language', () => {
    const sections = [swedish, { language: 'sv-FI', home_path: '/sv-fi/' }];
    expect(languageSectionFor(sections, 'sv-FI')?.home_path).toBe('/sv-fi/');
    expect(languageSectionFor(sections, 'sv')?.home_path).toBe('/sv/');
    expect(languageSectionFor(sections, 'fi')).toBeUndefined();
    expect(languageHomePath({ language_sections: sections }, 'fi')).toBe('/');
  });
});

describe('settingsForLanguage', () => {
  const settings: Partial<SiteSettings> = {
    language: 'fi',
    tagline: 'Muutto',
    default_meta_description: 'Suomeksi',
    cookie_consent: { enabled: true, text: '<p>Evästeet</p>', privacy_policy_url: '/evasteet/', labels: { accept_all: 'Hyväksy' }, scripts_optional: '<script>tag()</script>' },
    language_sections: [{ ...swedish, tagline: 'Flytt', cookie_consent: { text: '<p>Kakor</p>', privacy_policy_url: '/sv/cookies/' } }],
  };

  it('leaves site-language pages untouched', () => {
    expect(settingsForLanguage(settings, 'fi')).toBe(settings);
    expect(settingsForLanguage(settings, undefined)).toBe(settings);
  });

  it('overlays the section wording and keeps scripts site-wide', () => {
    const sv = settingsForLanguage(settings, 'sv-SE');
    expect(sv.tagline).toBe('Flytt');
    expect(sv.default_meta_description).toBe('Suomeksi');
    expect(sv.cookie_consent).toMatchObject({ enabled: true, text: '<p>Kakor</p>', privacy_policy_url: '/sv/cookies/', scripts_optional: '<script>tag()</script>' });
    // Finnish custom labels never reach a Swedish page: built-in Swedish wording does.
    expect(sv.cookie_consent?.labels).toBeUndefined();
  });

  it('falls back to built-in wording and the site-wide policy link when a section has no banner text', () => {
    const sv = settingsForLanguage({ ...settings, language_sections: [swedish] }, 'sv-SE');
    expect(sv.cookie_consent?.text).toBeUndefined();
    expect(sv.cookie_consent?.privacy_policy_url).toBe('/evasteet/');
  });
});

describe('breadcrumbs in a language section', () => {
  const registry = buildCoreBlockRegistry();
  const render = (language: string | undefined, homeLabel = 'Home', sections: unknown = [swedish]) => renderBlock(
    { id: 'crumbs', type: 'template/page_breadcrumbs', data: { home_label: homeLabel } },
    { registry, context: {
      site: { language: 'fi', language_sections: sections },
      page: { language, breadcrumbs: [{ label: 'Svenska', href: '/sv/' }, { label: 'Artikel', href: '/sv/artikel/', current: true }] },
    } },
  );

  it('links the home crumb to the section home in the page language and drops the repeated home page', () => {
    const html = render('sv-SE');
    expect(html).toContain('<a href="/sv/">Startsida</a>');
    expect(html).not.toContain('>Svenska<');
  });

  it('localizes the default label on site-language pages too', () => {
    expect(render(undefined)).toContain('<a href="/">Etusivu</a>');
  });

  it('keeps an authored label and the old output on sites without sections', () => {
    expect(render('sv-SE', 'Hem')).toContain('<a href="/sv/">Hem</a>');
    const plain = render('sv-SE', 'Home', null);
    expect(plain).toContain('<a href="/">Home</a>');
    expect(plain).toContain('<a href="/sv/">Svenska</a>');
  });
});
