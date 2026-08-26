// The editor shows a ghost placeholder for blocks that would render empty
// (a freshly dragged-in heading, an empty container). placeholderLabelFor is
// the pure decision behind that — verify it flags the right blocks.

import { describe, it, expect } from 'vitest';
import type { Block, BlockType } from '@typeroll/shared';
import { placeholderLabelFor } from '../../components/BlockPageEditor';

const heading: BlockType = {
  id: 'core/heading', name: 'heading', label: 'Heading', category: 'content', container: false,
  schema: [{ name: 'text', type: 'text', label: 'Heading text', required: true }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const section: BlockType = {
  id: 'core/section', name: 'section', label: 'Section', category: 'layout', container: true,
  schema: [], template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const image: BlockType = {
  id: 'core/image', name: 'image', label: 'Image', category: 'media', container: false,
  schema: [{ name: 'src', type: 'image', label: 'Image' }, { name: 'alt', type: 'text', label: 'Alt' }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

// A multi-content-field block (like a hero) with a heading + a button label.
const hero: BlockType = {
  id: 'core/hero', name: 'hero', label: 'Hero', category: 'content', container: false,
  schema: [
    { name: 'eyebrow', type: 'text', label: 'Eyebrow' },
    { name: 'heading', type: 'text', label: 'Heading', required: true },
    { name: 'primary_label', type: 'text', label: 'Button', required: true },
  ],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

// Real core shapes the type-based rule must handle (from the schema audit).
const pricingPlan: BlockType = {
  id: 'core/pricing_plan', name: 'pricing_plan', label: 'Pricing plan', category: 'content', container: false,
  schema: [
    { name: 'name', type: 'text', label: 'Name' }, { name: 'price', type: 'text', label: 'Price' },
    { name: 'features', type: 'array', label: 'Features' }, { name: 'highlight', type: 'boolean', label: 'Highlight' },
  ],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const teamMember: BlockType = {
  id: 'core/team_member', name: 'team_member', label: 'Team member', category: 'content', container: false,
  schema: [{ name: 'name', type: 'text', label: 'Name' }, { name: 'photo', type: 'image', label: 'Photo' }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const accordion: BlockType = {
  id: 'core/accordion', name: 'accordion', label: 'Accordion', category: 'content', container: false,
  schema: [{ name: 'items', type: 'array', label: 'Items' }, { name: 'style', type: 'select', label: 'Style' }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const pageTitle: BlockType = {
  id: 'template/page_title', name: 'page_title', label: 'Page title', category: 'content', container: false,
  schema: [{ name: 'fallback_text', type: 'text', label: 'Fallback' }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const spacer: BlockType = {
  id: 'core/spacer', name: 'spacer', label: 'Spacer', category: 'layout', container: false,
  schema: [{ name: 'height', type: 'select', label: 'Height' }],
  template: '', origin: 'core', created_at: '1970-01-01T00:00:00.000Z',
} as BlockType;

const b = (data: Record<string, unknown>, extra: Partial<Block> = {}): Block =>
  ({ id: 'x', type: 'core/heading', data, ...extra });

describe('placeholderLabelFor', () => {
  it('flags a heading with no text', () => {
    expect(placeholderLabelFor(b({}), heading)).toBe('Heading');
    expect(placeholderLabelFor(b({ text: '' }), heading)).toBe('Heading');
    expect(placeholderLabelFor(b({ text: '   ' }), heading)).toBe('Heading');
    expect(placeholderLabelFor(b({ text: '<p></p>' }), heading)).toBe('Heading');
  });

  it('does not flag a heading that has text', () => {
    expect(placeholderLabelFor(b({ text: 'Hej' }), heading)).toBeNull();
  });

  it('flags an empty container, not a filled one', () => {
    expect(placeholderLabelFor(b({}, { children: [] }), section)).toBe('Section');
    expect(placeholderLabelFor(b({}, { children: [b({ text: 'x' })] }), section)).toBeNull();
    // slot container with only-empty slots vs. a populated slot
    expect(placeholderLabelFor(b({}, { slots: [[], []] }), section)).toBe('Section');
    expect(placeholderLabelFor(b({}, { slots: [[], [b({ text: 'x' })]] }), section)).toBeNull();
  });

  it('flags an image with no src, not one with a src', () => {
    expect(placeholderLabelFor(b({}), image)).toBe('Image');
    expect(placeholderLabelFor(b({ src: 'https://x/y.png' }), image)).toBeNull();
  });

  it('does not flag a multi-field block that has a filled heading but empty button', () => {
    // Regression: the hero on the showcase page was wrongly flagged because a
    // secondary field (button label) was empty. It has real content.
    expect(placeholderLabelFor(b({ heading: 'Block-mode renderer', primary_label: '' }), hero)).toBeNull();
  });

  it('flags a multi-field block only when every content field is empty', () => {
    expect(placeholderLabelFor(b({ heading: '', primary_label: '' }), hero)).toBe('Hero');
  });

  it('returns null for an unknown block type', () => {
    expect(placeholderLabelFor(b({}), undefined)).toBeNull();
  });

  it('flags multi-field content blocks (pricing plan) when all fields are blank', () => {
    expect(placeholderLabelFor(b({}), pricingPlan)).toBe('Pricing plan');
    expect(placeholderLabelFor(b({ features: [] }), pricingPlan)).toBe('Pricing plan');
    expect(placeholderLabelFor(b({ name: 'Pro' }), pricingPlan)).toBeNull();
    expect(placeholderLabelFor(b({ features: [{ text: 'x' }] }), pricingPlan)).toBeNull();
  });

  it('flags a team member only when name AND photo are empty', () => {
    expect(placeholderLabelFor(b({}), teamMember)).toBe('Team member');
    expect(placeholderLabelFor(b({ name: 'Ada' }), teamMember)).toBeNull(); // name but no photo
    expect(placeholderLabelFor(b({ photo: 'https://x/p.jpg' }), teamMember)).toBeNull();
  });

  it('flags an accordion with an empty items array', () => {
    expect(placeholderLabelFor(b({ items: [] }), accordion)).toBe('Accordion');
    expect(placeholderLabelFor(b({ items: [{ title: 'Q', body: 'A' }] }), accordion)).toBeNull();
  });

  it('never flags template/* blocks (they render from context, not their data)', () => {
    expect(placeholderLabelFor(b({}), pageTitle)).toBeNull();
  });

  it('never flags blocks with no content-bearing fields (spacer)', () => {
    expect(placeholderLabelFor(b({}), spacer)).toBeNull();
  });
});
