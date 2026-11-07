// Offline fixtures for the organization collection UI tests.

import type { CollectionEntryView } from '../../components/collection-model';

export function entry(id: string, overrides: Partial<CollectionEntryView> = {}): CollectionEntryView {
  return {
    id,
    kind: 'section',
    name: id.replace(/(^|-)(\w)/g, (_, dash: string, char: string) => `${dash ? ' ' : ''}${char.toUpperCase()}`),
    source: { type: 'site', site_id: 'site-1' },
    updated_at: '2026-11-07T10:00:00.000Z',
    summary: { block_count: 4, styles: 2, block_types: 0, media: 1 },
    ...overrides,
  };
}

export const collectionEntries = (): CollectionEntryView[] => [
  entry('hero-split', { category: 'Heroes', description: 'Image beside a headline', preview_url: 'https://media.example/hero.jpg' }),
  entry('pricing-row', { kind: 'block_template', category: 'Pricing' }),
  entry('site-header', { kind: 'global_block', name: 'Site header', source: { type: 'package', package_name: 'Acme Sections', version: '1.2.0', publisher: 'Acme Studio', verified: true } }),
  entry('typeroll-feature-page', { name: 'Feature page', category: 'Page layouts', read_only: true, source: { type: 'builtin', publisher: 'Typeroll' } }),
  entry('typeroll-template-article', { kind: 'page_template', name: 'Article', read_only: true, source: { type: 'builtin', publisher: 'Typeroll' }, summary: { block_count: 3, styles: 0, block_types: 0, media: 0 } }),
  entry('booking-card', { kind: 'block_type', name: 'Booking card', source: { type: 'app', extension_id: 'bookings', publisher: 'Bookly' }, summary: { styles: 1, block_types: 1, media: 0 } }),
];

export const insertReport = () => ({
  report: {
    created: { block_templates: ['hero-split'], styles: ['hero-title', 'hero-title-2'] },
    reused: { styles: ['body'] },
    renamed: [{ section: 'styles', from: 'hero-title', to: 'hero-title-2' }],
    warnings: ['The image “team.jpg” is demo content.'],
  },
});
