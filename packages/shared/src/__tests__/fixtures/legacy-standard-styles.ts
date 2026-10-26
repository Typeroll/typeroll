// Frozen input for render versions 1–9. New-site defaults may evolve; stored site roles do not.
import type { SiteStyle } from '../../site-styles.js';
export const LEGACY_STANDARD_STYLES: readonly SiteStyle[] = [
  { id: 'body', name: 'Body text', role: 'body', targets: [], base: { size: '1rem', line_height: '1.6', color: 'text' }, at: { desktop: { size: '1.0625rem', line_height: '1.65' } } },
  { id: 'h1', name: 'Heading 1', role: 'h1', targets: [], base: { size: '2rem', weight: 700, line_height: '1.15', letter_spacing: '-0.02em' }, at: { tablet: { size: '2.5rem' }, desktop: { size: '3rem', line_height: '1.1' } } },
  { id: 'h2', name: 'Heading 2', role: 'h2', targets: [], base: { size: '1.5rem', weight: 700, line_height: '1.2', letter_spacing: '-0.01em' }, at: { tablet: { size: '1.875rem' }, desktop: { size: '2.25rem', line_height: '1.15' } } },
  { id: 'h3', name: 'Heading 3', role: 'h3', targets: [], base: { size: '1.25rem', weight: 600, line_height: '1.3' }, at: { tablet: { size: '1.375rem' }, desktop: { size: '1.5rem' } } },
  { id: 'h4', name: 'Heading 4', role: 'h4', targets: [], base: { size: '1.125rem', weight: 600, line_height: '1.35' }, at: { desktop: { size: '1.25rem' } } },
  { id: 'h5', name: 'Heading 5', role: 'h5', targets: [], base: { size: '1rem', weight: 600, line_height: '1.4' } },
  { id: 'h6', name: 'Heading 6', role: 'h6', targets: [], base: { size: '0.875rem', weight: 600, line_height: '1.4', letter_spacing: '0.04em', transform: 'uppercase' } },
  { id: 'link', name: 'Link', role: 'link', targets: [], base: { color: 'primary', decoration: 'underline' } },
  { id: 'lead', name: 'Lead', role: 'lead', targets: ['text'], description: 'Introductory paragraph under a page or section heading.', base: { size: '1.125rem', line_height: '1.55' }, at: { tablet: { size: '1.25rem' }, desktop: { size: '1.3125rem', line_height: '1.5' } } },
  { id: 'eyebrow', name: 'Eyebrow', role: 'eyebrow', targets: ['text', 'heading'], description: 'Short label above a heading.', base: { size: '0.8125rem', weight: 700, line_height: '1.3', letter_spacing: '0.12em', transform: 'uppercase', color: 'primary', space_after: '0.75rem' } },
  { id: 'small', name: 'Small text', role: 'small', targets: ['text', 'list'], description: 'Notes, captions and fine print.', base: { size: '0.875rem', line_height: '1.5', color: 'text_light' } },
  { id: 'quote', name: 'Quote', role: 'quote', targets: ['text'], description: 'Pull quote or testimonial.', base: { size: '1.25rem', line_height: '1.5', italic: true, padding: '0 0 0 1rem', border: { width: '3px', style: 'solid', color: 'primary', sides: 'left' } }, at: { desktop: { size: '1.375rem' } } },
  { id: 'button', name: 'Button', role: 'button', targets: ['button'], description: 'Primary call to action.', base: { background: 'primary', color: 'on_primary', weight: 600, padding: '0.75rem 1.25rem', radius: '0.5rem', decoration: 'none' } },
  { id: 'button-secondary', name: 'Secondary button', role: 'button_secondary', targets: ['button'], description: 'Secondary action next to a primary button.', base: { background: 'transparent', color: 'primary', weight: 600, padding: '0.6875rem 1.1875rem', radius: '0.5rem', decoration: 'none', border: { width: '1px', style: 'solid', color: 'primary' } } },
  { id: 'section', name: 'Section', role: 'section', targets: ['container'], description: 'Vertical rhythm for a page section.', base: { padding: '3rem 0' }, at: { tablet: { padding: '4rem 0' }, desktop: { padding: '6rem 0' } } },
];
