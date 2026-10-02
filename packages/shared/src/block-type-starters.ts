/**
 * Starting points for site block types: complete composed definitions that
 * the builder, the API and MCP offer when someone creates a block type. They
 * are plain definitions, written through the same validator as any other.
 */

import type { BlockType } from './types.js';

export interface BlockTypeStarter {
  id: string;
  label: string;
  description: string;
  definition: Pick<BlockType, 'name' | 'label' | 'category' | 'schema' | 'composition' | 'styles' | 'description' | 'icon'>;
}

const linkField = { name: 'link', type: 'link' as const, label: 'Link', help: 'A page on the site or an address. The whole item becomes a link.' };

export const BLOCK_TYPE_STARTERS: readonly BlockTypeStarter[] = [
  {
    id: 'icon_list',
    label: 'Icon list',
    description: 'A list where each item has an icon, a heading and a line of text, and can link somewhere.',
    definition: {
      name: 'icon_list', label: 'Icon list', category: 'content', icon: 'list',
      description: 'Short benefits or contact options, each with an icon.',
      schema: [
        { name: 'items', type: 'array', label: 'Items', item_label: 'title', min_items: 1, fields: [
          { name: 'icon', type: 'icon', label: 'Icon', default: 'check' },
          { name: 'title', type: 'text', label: 'Heading' },
          { name: 'text', type: 'text', label: 'Text' },
          linkField,
        ] },
      ],
      composition: [
        { id: 'list', type: 'core/repeater', data: { source_type: 'static', items: '{{props.items}}', layout: 'list', gap: 'md' }, children: [
          { id: 'item', type: 'core/container', data: { tag: 'a', href: '{{item.link.href}}', new_tab: '{{item.link.new_tab}}', direction: 'row', wrap: 'nowrap', gap: 'md', align_cross: 'flex-start', padding_y: 'none', padding_x: 'none', css_class: 'icon-list-item' }, children: [
            { id: 'icon', type: 'core/icon', data: { icon: '{{item.icon}}', size: 'lg' } },
            { id: 'body', type: 'core/container', data: { gap: 'xs', padding_y: 'none', padding_x: 'none' }, children: [
              { id: 'title', type: 'core/heading', data: { text: '{{item.title}}', level: 'h3' } },
              { id: 'text', type: 'core/text', data: { text: '{{item.text}}' } },
            ] },
          ] },
        ] },
      ],
      styles: `.icon-list-item { color: inherit; text-decoration: none; }
a.icon-list-item:hover [data-block="heading"], a.icon-list-item:focus-visible [data-block="heading"] { text-decoration: underline; }
[data-block="heading"] { margin: 0; font-size: 1.125rem; }
[data-block="icon"] { color: var(--color-primary, currentColor); }`,
    },
  },
  {
    id: 'feature_cards',
    label: 'Feature cards',
    description: 'A grid of cards with an image, a heading, a short text and an optional link.',
    definition: {
      name: 'feature_cards', label: 'Feature cards', category: 'content', icon: 'layout-grid',
      description: 'Services, products or articles shown as cards.',
      schema: [
        { name: 'columns', type: 'select', label: 'Columns', options: ['2', '3', '4'], default: '3' },
        { name: 'cards', type: 'array', label: 'Cards', item_label: 'title', min_items: 1, fields: [
          { name: 'image', type: 'image', label: 'Image' },
          { name: 'title', type: 'text', label: 'Heading' },
          { name: 'text', type: 'textarea', label: 'Text' },
          linkField,
        ] },
      ],
      composition: [
        { id: 'grid', type: 'core/repeater', data: { source_type: 'static', items: '{{props.cards}}', layout: 'grid', cols: 3 }, children: [
          { id: 'card', type: 'core/container', data: { tag: 'a', href: '{{item.link.href}}', new_tab: '{{item.link.new_tab}}', gap: 'sm', padding_y: 'none', padding_x: 'none', css_class: 'feature-card' }, children: [
            { id: 'image', type: 'core/image', data: { src: '{{item.image}}', alt: '', aspect_ratio: '4:3', fit: 'cover' } },
            { id: 'title', type: 'core/heading', data: { text: '{{item.title}}', level: 'h3' } },
            { id: 'text', type: 'core/text', data: { text: '{{item.text}}' } },
          ] },
        ] },
      ],
      styles: `.feature-card { color: inherit; text-decoration: none; }
a.feature-card:hover [data-block="heading"], a.feature-card:focus-visible [data-block="heading"] { text-decoration: underline; }
[data-block="heading"] { margin: 0; }`,
    },
  },
  {
    id: 'steps',
    label: 'Numbered steps',
    description: 'A short process: numbered steps with a heading and a text each.',
    definition: {
      name: 'steps', label: 'Numbered steps', category: 'content', icon: 'list-ordered',
      description: 'How something works, in order.',
      schema: [
        { name: 'steps', type: 'array', label: 'Steps', item_label: 'title', min_items: 2, fields: [
          { name: 'title', type: 'text', label: 'Heading' },
          { name: 'text', type: 'textarea', label: 'Text' },
        ] },
      ],
      composition: [
        { id: 'list', type: 'core/repeater', data: { source_type: 'static', items: '{{props.steps}}', layout: 'grid', cols: 3 }, children: [
          { id: 'step', type: 'core/container', data: { gap: 'xs', padding_y: 'none', padding_x: 'none', css_class: 'step' }, children: [
            { id: 'title', type: 'core/heading', data: { text: '{{item.title}}', level: 'h3' } },
            { id: 'text', type: 'core/text', data: { text: '{{item.text}}' } },
          ] },
        ] },
      ],
      styles: `:scope { counter-reset: step; }
.step { counter-increment: step; }
.step::before { content: counter(step); display: inline-grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 50%; background: var(--color-primary, #111); color: var(--color-primary-fg, #fff); font-weight: 700; }
[data-block="heading"] { margin: 0; font-size: 1.125rem; }`,
    },
  },
];
