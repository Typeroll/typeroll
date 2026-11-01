import { describe, expect, it } from 'vitest';
import { faqItemsFromHtml, faqPageJsonLd, jsonLdDeclaresType } from '../faq-jsonld.js';

const accordion = (items: Array<[string, string]>) =>
  `<div data-block="accordion" data-style="bordered" data-icon="chevron" data-default-open="none">${items.map(([q, a]) => `<details><summary>${q}</summary><div>${a}</div></details>`).join('')}</div>`;

describe('FAQPage from accordions', () => {
  it('builds questions and plain-text answers from a rendered accordion', () => {
    const html = `<section><h2>FAQ</h2>${accordion([['What does Beta mean?', '<p>It is <strong>stable</strong> &amp; supported.</p>'], ['Is it open source?', '<p>Yes.</p><ul><li>Core</li><li>MCP</li></ul>']])}</section>`;
    expect(JSON.parse(faqPageJsonLd(html)!)).toEqual({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'What does Beta mean?', acceptedAnswer: { '@type': 'Answer', text: 'It is stable & supported.' } },
        { '@type': 'Question', name: 'Is it open source?', acceptedAnswer: { '@type': 'Answer', text: 'Yes. Core MCP' } },
      ],
    });
  });
  it('accepts question marks in other scripts', () => {
    expect(faqItemsFromHtml(accordion([['هل هو مجاني؟', 'نعم'], ['無料ですか？', 'はい']]))).toHaveLength(2);
  });
  it('skips an accordion with a non-question title or an empty answer, but keeps other qualifying ones', () => {
    const specs = accordion([['Dimensions', '20 × 30 cm'], ['Is it waterproof?', 'Yes']]);
    const empty = accordion([['Can I cancel?', '  ']]);
    const faq = accordion([['Can I export?', 'Yes, as JSON.']]);
    expect(faqItemsFromHtml(specs + empty + faq)).toEqual([{ question: 'Can I export?', answer: 'Yes, as JSON.' }]);
    expect(faqPageJsonLd(specs + empty)).toBeNull();
  });
  it('ignores pages without accordions and the version 1–3 empty accordion', () => {
    expect(faqPageJsonLd('<p>Hello?</p>')).toBeNull();
    expect(faqPageJsonLd('<div data-block="accordion" data-items="[object Object]"></div>')).toBeNull();
  });
  it('does not repeat a question that appears twice', () => {
    expect(faqItemsFromHtml(accordion([['Why?', 'Because.']]) + accordion([['Why?', 'Because.']]))).toHaveLength(1);
  });
  it('detects an explicit FAQPage in page or content-type JSON-LD', () => {
    expect(jsonLdDeclaresType(['{"@type":"FAQPage","mainEntity":[]}'], 'FAQPage')).toBe(true);
    expect(jsonLdDeclaresType(['[{"@type":"Organization"},{"@type":["FAQPage"]}]'], 'FAQPage')).toBe(true);
    expect(jsonLdDeclaresType(['{"@graph":[{"@type":"FAQPage"}]}'], 'FAQPage')).toBe(true);
    expect(jsonLdDeclaresType([null, '{"@type":"Article"}', 'not json'], 'FAQPage')).toBe(false);
  });
});
