// Editable starting block trees for common marketing pages: a feature, a
// comparison, an integration, pricing and a use case. They are Page bodies,
// not Page templates: read one with `get_composition_starter`, replace the
// bracketed placeholders and save it with create_page or update_page.
// Everything is built from ordinary core blocks, so a site restyles them
// through its theme and Styles like any other content.

import type { Block } from './types.js';

export const PAGE_BODY_STARTER_KINDS = ['feature_page', 'comparison_page', 'integration_page', 'pricing_page', 'use_case_page'] as const;
export type PageBodyStarterKind = (typeof PAGE_BODY_STARTER_KINDS)[number];

export function isPageBodyStarterKind(value: unknown): value is PageBodyStarterKind {
  return typeof value === 'string' && (PAGE_BODY_STARTER_KINDS as readonly string[]).includes(value);
}

function block(id: string, type: string, data: Record<string, unknown>, children?: Block[]): Block {
  return { id: `starter_${id}`, type, data, ...(children ? { children } : {}) };
}

function section(id: string, children: Block[], data: Record<string, unknown> = {}): Block {
  return block(`${id}_section`, 'core/section', { width: 'normal', ...data }, children);
}

function heading(id: string, text: string, level = 'h2', subtitle?: string): Block {
  return block(id, 'core/heading', { text, level, size: 'auto', ...(subtitle ? { subtitle } : {}) });
}

function prose(id: string, html: string): Block {
  return block(id, 'core/prose', { html });
}

function features(id: string, items: Array<{ heading: string; text: string }>, cols = 3): Block {
  return block(id, 'core/feature_grid', { items: items.map(item => ({ icon: '', link: '', ...item })), cols, mobile_cols: 1 });
}

function faq(id: string, items: Array<{ title: string; content: string }>): Block {
  return section(id, [heading(`${id}_heading`, 'Frequently asked questions'), block(`${id}_items`, 'core/accordion', { items, style: 'separated', default_open: 'none' })]);
}

function closing(id: string, headingText: string, label: string): Block {
  return block(id, 'core/cta', {
    heading: headingText,
    subheading: '<p>[One sentence on what happens after the click.]</p>',
    primary_label: label,
    primary_url: '/[signup-or-contact]/',
    align: 'center',
  });
}

function hero(id: string, eyebrow: string, title: string, lead: string, primary: string, secondary?: string): Block {
  return block(id, 'core/hero', {
    eyebrow,
    heading: title,
    subheading: `<p>${lead}</p>`,
    primary_label: primary,
    primary_url: '/[signup-or-contact]/',
    ...(secondary ? { secondary_label: secondary, secondary_url: '/[guide-or-docs]/' } : {}),
    layout: 'centered',
    text_align: 'center',
  });
}

function cell(html: string, header = false): Record<string, unknown> {
  return header ? { html, header: true } : { html };
}

function starter(kind: PageBodyStarterKind): Block[] {
  switch (kind) {
    case 'feature_page':
      return [
        hero('hero', '[Feature category]', '[Feature name]: [the outcome it gives]', '[Who it is for and the problem it removes, in one or two sentences.]', '[Start free]', '[Read the guide]'),
        section('benefits', [
          heading('benefits_heading', '[What you can do with it]'),
          features('benefits_grid', [
            { heading: '[Benefit one]', text: '<p>[A concrete result, not a claim.]</p>' },
            { heading: '[Benefit two]', text: '<p>[A concrete result, not a claim.]</p>' },
            { heading: '[Benefit three]', text: '<p>[A concrete result, not a claim.]</p>' },
          ]),
        ]),
        section('how', [
          heading('how_heading', 'How it works'),
          prose('how_steps', '<ol><li>[First step]</li><li>[Second step]</li><li>[Third step]</li></ol>'),
          block('how_link', 'core/button', { label: '[Read the step-by-step guide]', href: '/[guide]/', variant: 'secondary' }),
        ]),
        faq('faq', [
          { title: '[A question buyers ask]', content: '<p>[A direct answer.]</p>' },
          { title: '[A question about limits or requirements]', content: '<p>[A direct answer.]</p>' },
        ]),
        closing('cta', '[Try feature name]', '[Start free]'),
      ];
    case 'comparison_page':
      return [
        hero('hero', 'Comparison', '[Your product] vs [Other product]', '[One fair sentence on how they differ and who each one suits.]', '[Try your product]'),
        section('summary', [
          heading('summary_heading', 'Summary'),
          prose('summary_text', '<p>[Two or three sentences: the main difference, and when each one is the better choice.]</p><p><em>Last checked: [date]. Sources: [links to the other product\'s own documentation].</em></p>'),
        ]),
        section('table', [
          heading('table_heading', 'Feature comparison'),
          block('table_grid', 'core/table', {
            caption: '[Your product] and [Other product] compared',
            rows: [
              { cells: [cell('Feature', true), cell('[Your product]', true), cell('[Other product]', true)] },
              { cells: [cell('[Capability]'), cell('[Yes, with detail]'), cell('[Yes, no or partial, with detail]')] },
              { cells: [cell('[Capability]'), cell('[Detail]'), cell('[Detail]')] },
              { cells: [cell('[Pricing model]'), cell('[Detail]'), cell('[Detail]')] },
            ],
            density: 'normal',
            borders: 'rows',
            striped: true,
          }),
        ]),
        section('choose', [
          heading('choose_heading', 'Which one should you choose?'),
          features('choose_grid', [
            { heading: 'Choose [your product] if…', text: '<ul><li>[Situation]</li><li>[Situation]</li></ul>' },
            { heading: 'Choose [other product] if…', text: '<ul><li>[Situation]</li><li>[Situation]</li></ul>' },
          ], 2),
        ]),
        faq('faq', [
          { title: 'Can I move from [other product] to [your product]?', content: '<p>[Answer, with a link to the migration guide.]</p>' },
        ]),
        closing('cta', '[See your product in action]', '[Start free]'),
      ];
    case 'integration_page':
      return [
        hero('hero', 'Integration', '[Your product] + [Tool]', '[What the integration lets people do, in one sentence.]', '[Connect Tool]', '[Setup guide]'),
        section('can', [
          heading('can_heading', 'What you can do'),
          features('can_grid', [
            { heading: '[Task]', text: '<p>[What happens, end to end.]</p>' },
            { heading: '[Task]', text: '<p>[What happens, end to end.]</p>' },
            { heading: '[Task]', text: '<p>[What happens, end to end.]</p>' },
          ]),
        ]),
        section('setup', [
          heading('setup_heading', 'Set it up'),
          prose('setup_steps', '<ol><li>[Step]</li><li>[Step, with the exact setting name]</li><li>[How to check that it works]</li></ol><pre><code>[Configuration snippet, if any]</code></pre>'),
        ]),
        faq('faq', [
          { title: '[What does Tool need access to?]', content: '<p>[Answer.]</p>' },
        ]),
        closing('cta', '[Connect Tool to your product]', '[Get started]'),
      ];
    case 'pricing_page':
      return [
        section('intro', [
          heading('intro_heading', 'Pricing', 'h1', '[One sentence on how pricing works.]'),
        ], { width: 'wide' }),
        section('plans', [
          block('plans_table', 'core/pricing_table', {
            cols: 3,
            mobile_cols: 1,
            items: [
              { name: '[Plan]', price: '[Price]', period: '[per month]', description: '[Who it is for]', features: [{ text: '[Included feature]', included: true }, { text: '[Feature not included]', included: false }], cta_label: '[Choose plan]', cta_href: '/[signup]/', highlight: false },
              { name: '[Plan]', price: '[Price]', period: '[per month]', description: '[Who it is for]', features: [{ text: '[Included feature]', included: true }, { text: '[Included feature]', included: true }], cta_label: '[Choose plan]', cta_href: '/[signup]/', highlight: true, badge: '[Most popular]' },
              { name: '[Plan]', price: '[Price or Contact us]', period: '', description: '[Who it is for]', features: [{ text: '[Included feature]', included: true }], cta_label: '[Contact us]', cta_href: '/[contact]/', highlight: false },
            ],
          }),
        ], { width: 'wide' }),
        section('compare', [
          heading('compare_heading', 'Compare plans'),
          block('compare_table', 'core/table', {
            rows: [
              { cells: [cell('Feature', true), cell('[Plan]', true), cell('[Plan]', true), cell('[Plan]', true)] },
              { cells: [cell('[Feature]'), cell('[Value]'), cell('[Value]'), cell('[Value]')] },
            ],
            borders: 'rows',
          }),
        ]),
        faq('faq', [
          { title: '[Is there a free trial?]', content: '<p>[Answer.]</p>' },
          { title: '[Can I change plans later?]', content: '<p>[Answer.]</p>' },
        ]),
        closing('cta', '[Still deciding?]', '[Talk to us]'),
      ];
    case 'use_case_page':
      return [
        hero('hero', '[Industry or role]', '[Product] for [audience]', '[The job this audience needs done, and how the product does it.]', '[Start free]', '[See an example]'),
        section('problem', [
          heading('problem_heading', '[The problem today]'),
          prose('problem_text', '<p>[What this audience struggles with, in their own words.]</p>'),
        ]),
        section('solution', [
          heading('solution_heading', 'How [product] helps'),
          features('solution_grid', [
            { heading: '[Capability]', text: '<p>[The result for this audience.]</p>' },
            { heading: '[Capability]', text: '<p>[The result for this audience.]</p>' },
            { heading: '[Capability]', text: '<p>[The result for this audience.]</p>' },
          ]),
        ]),
        section('example', [
          heading('example_heading', 'Example'),
          prose('example_text', '<p>[A short, real example with a measurable outcome. Leave this out until you have one.]</p>'),
        ]),
        faq('faq', [
          { title: '[A question this audience asks]', content: '<p>[Answer.]</p>' },
        ]),
        closing('cta', '[Get started with product]', '[Start free]'),
      ];
  }
}

/** A fresh, editable copy every call. Placeholders are in square brackets. */
export function getPageBodyStarter(kind: PageBodyStarterKind): Block[] {
  return structuredClone(starter(kind));
}
