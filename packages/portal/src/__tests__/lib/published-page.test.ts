import { describe, expect, it } from 'vitest';
import { publishedPageProjection } from '../../lib/publishing/published-page';

function publication() {
  return { site_url: 'https://site.example.test', contentTypes: [{ id: 'company', route_template: '/companies/{slug}/', fields: [
    { name: 'programs', type: 'array', fields: [{ name: 'name', type: 'text' }, { name: 'private_note', type: 'text', rendered: false }] },
    { name: 'claim_email', type: 'text', rendered: false },
  ] }], pages: [{ id: 'company-one', title: 'Published Company', slug: 'company-one', content_type: 'company', status: 'published',
    fields: { programs: [{ name: 'Public program', private_note: 'PRIVATE' }], claim_email: 'private@example.test', unknown: 'UNDECLARED' },
    _provenance: { private: 'INTERNAL' }, html_content: '<p>Arbitrary page content</p>' }] };
}
describe('verified published page projection', () => {
  it('returns public structured facts and a stable source revision without body, provenance or private fields', () => {
    const result = publishedPageProjection(publication(), 'company-one')!;
    expect(result.page).toEqual({ id: 'company-one', title: 'Published Company', content_type: 'company', status: 'published',
      fields: { programs: [{ name: 'Public program' }] }, url: 'https://site.example.test/companies/company-one' });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|INTERNAL|UNDECLARED|private@example/);
    const changed = publication(); changed.pages[0]!.fields.claim_email = 'other-private@example.test';
    expect(publishedPageProjection(changed, 'company-one')!.revision).toBe(result.revision);
  });
  it('does not return a draft or substitute a different profile', () => {
    const source = publication(); source.pages[0]!.status = 'draft';
    expect(publishedPageProjection(source, 'company-one')).toBeNull();
    expect(publishedPageProjection(publication(), 'missing')).toBeNull();
  });
  it('binds the revision to actual public facts and address', () => {
    const source = publication(), before = publishedPageProjection(source, 'company-one')!;
    source.pages[0]!.fields.programs[0]!.name = 'New published program';
    expect(publishedPageProjection(source, 'company-one')!.revision).not.toBe(before.revision);
  });
  it('refuses off-site or credential-bearing public addresses', () => {
    const source = publication() as Record<string, any>;
    source.pages[0].path = '//other.example.test/stolen';
    expect(publishedPageProjection(source, 'company-one')).toBeNull();
    source.pages[0].path = '/company'; source.site_url = 'https://user:password@site.example.test';
    expect(publishedPageProjection(source, 'company-one')).toBeNull();
  });
});
