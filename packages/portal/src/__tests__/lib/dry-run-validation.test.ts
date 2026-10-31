import { describe, expect, it } from 'vitest';
import { dryRunValidationIssues, publicationLanguageWarnings } from '../../lib/publishing/dry-run-validation';

it('finds unnamed image links in image blocks and stored HTML, including nested blocks', () => {
  const pages = [
    { id: 'a', path: '/a', blocks: [{ type: 'core/columns', data: {}, children: [{ type: 'core/image', data: { src: '/x.png', link: 'https://partner.example', alt: ' ' } }] }] },
    { id: 'b', path: '/b', blocks: [{ type: 'core/prose', data: { html: '<a href="/c"><img src="/c.png" alt=""></a><a href="/d"><img src="/d.png" alt="Named"></a><a href="/e" aria-label="Label"><img src="/e.png" alt=""></a>' } }] },
    { id: 'c', path: '/c', html_content: '<a href="/f"><img src="/f.png"> Visible text</a>', blocks: [{ type: 'core/image', data: { src: '/x.png', link: '/g', alt: 'Described' } }] },
  ];
  expect(dryRunValidationIssues(pages)).toEqual([
    { code: 'image_link_unnamed', page: '/a', href: 'https://partner.example', source: 'image_block' },
    { code: 'image_link_unnamed', page: '/b', href: '/c', source: 'html' },
  ]);
});

describe('publication language warnings', () => {
  const labels = { title: 'Evästeet', reject: 'Hylkää', necessary: 'Vain välttämättömät', accept_all: 'Hyväksy kaikki', privacy_link: 'Tietosuoja', manage: 'Asetukset' };

  it('stays quiet for languages with built-in text', () => {
    expect(publicationLanguageWarnings({ settings: { language: 'nl-NL', cookie_consent: { enabled: true } }, pages: [{ language: 'de' }, { language: 'en-GB' }] })).toEqual([]);
  });

  it('lists the English fallbacks of an untranslated language, including missing banner wording', () => {
    const warnings = publicationLanguageWarnings({ settings: { language: 'fi', cookie_consent: { enabled: true, labels: { title: 'Evästeet' } } }, pages: [{ language: 'fi' }] });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('no built-in fi interface text');
    expect(warnings[1]).toContain('cookie_consent.text, cookie_consent.labels.reject');
    expect(warnings[1]).not.toContain('labels.title');
  });

  it('drops the banner warning once every label and the text are saved', () => {
    const warnings = publicationLanguageWarnings({ settings: { language: 'fi', cookie_consent: { enabled: true, text: '<p>Evästeet</p>', labels } } });
    expect(warnings).toHaveLength(1);
  });
});
