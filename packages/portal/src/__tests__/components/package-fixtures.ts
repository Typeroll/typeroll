// Shared fixtures for the Packages page tests: an inspected package and what
// a site can export, shaped like the packages API's responses.

import type { InspectResult } from '../../components/package-import-model';
import type { Exportable } from '../../components/package-export-model';

export const inspected = (overrides: Partial<InspectResult> = {}): InspectResult => ({
  package: {
    id: 'acme-sections', name: 'Acme Sections', version: '1.2.0', kind: 'collection', description: 'Heroes and pricing tables',
    author: { name: 'Acme Studio', url: 'https://acme.example' }, licence: { name: 'Acme Commercial', url: 'https://acme.example/licence' },
    languages: ['en', 'sv'], created_at: '2026-11-01T10:00:00.000Z',
    counts: { block_templates: 2, page_templates: 1, global_blocks: 1, block_types: 1, styles: 3, menus: 0, pages: 0, media: 4, fonts: 0 },
  },
  signature: { status: 'unsigned' },
  plan: {
    styles: [
      { action: 'create', from: 'card', to: 'card', name: 'Card' },
      { action: 'reuse', from: 'lead', to: 'lead', name: 'Lead' },
      { action: 'rename', from: 'hero', to: 'hero-2', name: 'Hero (imported)' },
    ],
    block_types: [{ action: 'create', from: 'price-row', to: 'price-row' }],
    block_templates: [{ action: 'create', from: 'hero', to: 'hero', name: 'Hero' }, { action: 'rename', from: 'pricing', to: 'pricing-2', name: 'Pricing' }],
    page_templates: [{ action: 'create', from: 'landing', to: 'landing', name: 'Landing' }],
    global_blocks: [{ action: 'create', from: 'cta', to: 'cta', name: 'Call to action', kind: 'free' }],
    menus: [],
    site_field_groups: [{ action: 'skip', id: 'contact' }],
    pages: [],
    design: null,
    fonts: [],
    media: ['m1', 'm2'],
  },
  warnings: [],
  needs: { admin: false, font_licence: false },
  ...overrides,
});

export const exportable: Exportable = {
  block_templates: [{ id: 'hero', name: 'Hero', kind: 'section', category: 'Heroes' }, { id: 'quote', name: 'Quote', kind: 'block' }],
  page_templates: [{ id: 'landing', name: 'Landing' }],
  global_blocks: [{ id: 'cta', name: 'Call to action' }],
  block_types: [{ id: 'price-row', label: 'Price row' }],
  styles: [{ id: 'card', name: 'Card' }, { id: 'body', name: 'Body', role: 'body' }],
  font_families: [{ family: 'Brand Serif', source: 'upload' }, { family: 'Inter', source: 'catalog' }, { family: 'Proxima Nova', source: 'service' }, { family: 'Acme', source: 'upload' }],
  media: [{ id: 'm1', filename: 'hero.jpg', url: 'https://media.example/hero.jpg', demo: true }, { id: 'm2', filename: 'logo.svg', url: 'https://media.example/logo.svg' }],
};
