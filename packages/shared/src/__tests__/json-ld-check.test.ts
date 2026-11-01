import { describe, expect, it } from 'vitest';
import { checkJsonLd } from '../json-ld-check.js';

describe('page JSON-LD check', () => {
  it('ignores empty input and reports malformed JSON', () => {
    expect(checkJsonLd('')).toEqual([]);
    expect(checkJsonLd(undefined)).toEqual([]);
    expect(checkJsonLd('{nope')).toEqual([expect.objectContaining({ code: 'jsonld_malformed' })]);
  });

  it('accepts a complete FAQPage', () => {
    expect(checkJsonLd(JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }] }))).toEqual([]);
  });

  it('reports FAQ questions without an answer', () => {
    const issues = checkJsonLd({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] });
    expect(issues).toEqual([expect.objectContaining({ type: 'FAQPage', path: 'mainEntity[0]' })]);
  });

  it('requires one of offers, review or aggregateRating for software and products', () => {
    expect(checkJsonLd({ '@type': 'SoftwareApplication', name: 'Typeroll' })).toEqual([expect.objectContaining({ code: 'jsonld_missing_property', message: 'SoftwareApplication needs one of offers, review, aggregateRating.' })]);
    expect(checkJsonLd({ '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' } })).toEqual([]);
  });

  it('checks every object in an array or @graph', () => {
    const issues = checkJsonLd({ '@graph': [{ '@type': 'Event', name: 'Launch', startDate: '2026-13-45', location: 'Online' }, { '@type': 'Organization' }] });
    expect(issues.map(issue => issue.code)).toEqual(['jsonld_invalid_date', 'jsonld_missing_property']);
  });

  it('reports URLs that are not http(s) and accepts root-relative paths', () => {
    const issues = checkJsonLd({ '@type': 'Organization', name: 'Acme', logo: '/logo.png', sameAs: ['https://github.com/acme', 'javascript:alert(1)'] });
    expect(issues).toEqual([expect.objectContaining({ code: 'jsonld_invalid_url', path: 'sameAs[1]' })]);
  });
});
