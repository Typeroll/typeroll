import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, llmsFull, llmsGroups, llmsIndex, markdownPathFor, pageMarkdown, type AgentPage, type ContentType, type Page } from '../index.js';

const page = (over: Partial<Page>): Page => ({ id: 'p', title: 'About us', slug: 'about', status: 'published', content_mode: 'blocks', blocks: [], ...over } as Page);

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis, links, lists, quotes and tables', () => {
    const markdown = htmlToMarkdown([
      '<h2>Our <em>story</em></h2><p>We build <strong>fast</strong> sites. <a href="/contact/">Contact us</a>.</p>',
      '<ul><li>One</li><li>Two &amp; three</li></ul><ol start="3"><li>Third</li></ol>',
      '<blockquote><p>Quoted</p></blockquote>',
      '<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>10 | 20</td></tr></table>',
      '<script>alert(1)</script><p><img src="/a.png" alt="A chart"></p>',
    ].join(''), 'https://example.com/about/');
    expect(markdown).toBe([
      '## Our *story*',
      'We build **fast** sites. [Contact us](https://example.com/contact/).',
      '- One\n- Two & three',
      '3. Third',
      '> Quoted',
      '| Plan | Price |\n| --- | --- |\n| Basic | 10 \\| 20 |',
      '![A chart](https://example.com/a.png)',
    ].join('\n\n'));
  });

  it('drops script URLs and keeps link text', () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">Click</a></p>')).toBe('Click');
  });
});

describe('pageMarkdown', () => {
  it('renders the page title, description, fields and blocks, skipping layout and forms', () => {
    const type = { id: 'service', name: 'service', label_singular: 'Service', label_plural: 'Services', route_template: '/services/{slug}', created_at: '',
      fields: [{ name: 'price', type: 'text', label: 'Price' }, { name: 'internal', type: 'text', label: 'Internal', rendered: false }] } as ContentType;
    const markdown = pageMarkdown(page({
      title: 'Moving help', seo_description: 'Moving in Helsinki.', language: 'en', date_updated: '2026-10-01T10:00:00Z',
      fields: { price: 'From 99 €', internal: 'secret' },
      blocks: [
        { id: 's', type: 'core/section', data: {}, children: [
          { id: 'h', type: 'core/heading', data: { text: 'What we do', level: 'h2' } },
          { id: 'p', type: 'core/prose', data: { html: '<p>We carry boxes.</p>' } },
          { id: 'sp', type: 'core/spacer', data: {} },
          { id: 'f', type: 'core/form', data: { form_id: 'x' } },
          { id: 'b', type: 'core/button', data: { label: 'Get a quote', href: '/quote/' } },
          { id: 'i', type: 'core/image', data: { src: 'https://cdn.example.com/van.jpg', alt: 'Our van' } },
        ] },
        { id: 'a', type: 'core/accordion', data: { items: [{ title: 'Do you pack?', content: '<p>Yes.</p>' }] } },
        { id: 't', type: 'core/table', data: { rows: [{ cells: [{ html: 'Size', header: true }, { html: 'Price', header: true }] }, { cells: [{ html: 'Studio' }, { html: '<p>99 €</p>' }] }] } },
        { id: 'hidden', type: 'core/prose', data: { html: '<p>Hidden everywhere</p>' }, hidden_on: ['mobile', 'tablet', 'desktop'] },
      ],
    }), { url: 'https://example.com/services/moving/', contentType: type });
    expect(markdown).toBe([
      '# Moving help',
      '> Moving in Helsinki.',
      'URL: https://example.com/services/moving/  \nUpdated: 2026-10-01  \nLanguage: en',
      '- **Price:** From 99 €',
      '## What we do',
      'We carry boxes.',
      '[Get a quote](https://example.com/quote/)',
      '![Our van](https://cdn.example.com/van.jpg)',
      '**Do you pack?**',
      'Yes.',
      '| Size | Price |\n| --- | --- |\n| Studio | 99 € |',
    ].join('\n\n') + '\n');
    expect(markdown).not.toContain('secret');
  });

  it('renders text fields of other blocks generically, including repeated items', () => {
    const markdown = pageMarkdown(page({ blocks: [
      { id: 'hero', type: 'core/hero', data: { heading: 'Fast sites', subheading: '<p>Built by agents.</p>', primary_label: 'Start', primary_url: '/start/' } },
      { id: 'grid', type: 'core/feature_grid', data: { items: [{ heading: 'Fast', text: '<p>Static.</p>' }, { heading: 'Safe', text: 'No plugins.' }] } },
      { id: 'plans', type: 'core/pricing_table', data: { items: [{ name: 'Pro', price: '10 €', features: [{ text: 'Forms', included: true }, { text: 'SSO', included: false }] }] } },
    ] }), { url: 'https://example.com/' });
    expect(markdown).toContain('### Fast sites\n\nBuilt by agents.\n\n[Start](https://example.com/start/)');
    expect(markdown).toContain('#### Fast\n\nStatic.\n\n#### Safe\n\nNo plugins.');
    expect(markdown).toContain('#### Pro\n\n10 €\n\n- Forms\n- ~~SSO~~');
  });

  it('resolves page bindings and drops unknown template expressions', () => {
    const markdown = pageMarkdown(page({ title: 'Kim', fields: { role: 'Editor' }, blocks: [{ id: 'h', type: 'core/heading', data: { text: '{{page.title}} — {{page.role}}{{site.name}}', level: 'h2' } }] }), { url: 'https://example.com/kim/' });
    expect(markdown).toContain('## Kim — Editor');
  });

  it('converts an HTML-mode page', () => {
    expect(pageMarkdown(page({ content_mode: 'html', html_content: '<h2>Hi</h2><p>Text</p>' }), { url: 'https://example.com/' })).toContain('## Hi\n\nText');
  });
});

describe('llms.txt and llms-full.txt', () => {
  const types = {
    page: { id: 'page', label_plural: 'Pages' } as ContentType,
    article: { id: 'article', label_plural: 'Articles' } as ContentType,
  };
  const entry = (title: string, path: string, type: ContentType, section?: string, description?: string): AgentPage => ({
    page: page({ title, seo_description: description, blocks: [{ id: 'p', type: 'core/prose', data: { html: `<p>${title} body.</p>` } }] }),
    type, path, markdownPath: markdownPathFor(path), section,
  });
  const pages = [
    entry('Tips', '/tips/moving/', types.article),
    entry('Home', '/', types.page, undefined, 'Moving company.'),
    entry('Hem', '/sv/', types.page, 'sv-SE'),
    entry('Tips sv', '/sv/tips/', types.article, 'sv-SE'),
  ];
  const settings = { site_name: 'Muutto', tagline: 'Move without stress', language: 'fi', language_sections: [{ language: 'sv-SE', home_path: '/sv/' }] } as never;

  it('maps paths to Markdown files', () => {
    expect(markdownPathFor('/')).toBe('/index.md');
    expect(markdownPathFor('/about/')).toBe('/about/index.md');
    expect(markdownPathFor('/about')).toBe('/about/index.md');
  });

  it('groups by content type, site language first, then language sections', () => {
    expect(llmsGroups(settings, pages).map(group => group.heading)).toEqual(['Pages', 'Articles', 'Pages (sv-SE)', 'Articles (sv-SE)']);
  });

  it('writes an index with descriptions, the sitemap and the full file', () => {
    const text = llmsIndex(settings, pages, 'https://muutto.fi');
    expect(text).toBe([
      '# Muutto', '', '> Move without stress', '',
      'Each page below links to its web address. A Markdown version of every page is at the same address followed by `index.md`.', '',
      '- [Sitemap](https://muutto.fi/sitemap.xml)',
      '- [All pages as Markdown](https://muutto.fi/llms-full.txt)', '',
      '## Pages', '', '- [Home](https://muutto.fi/): Moving company.', '',
      '## Articles', '', '- [Tips](https://muutto.fi/tips/moving/)', '',
      '## Pages (sv-SE)', '', '- [Hem](https://muutto.fi/sv/)', '',
      '## Articles (sv-SE)', '', '- [Tips sv](https://muutto.fi/sv/tips/)', '',
    ].join('\n'));
  });

  it('concatenates page Markdown in the same order and links the rest past the size cap', () => {
    const full = llmsFull(settings, pages, 'https://muutto.fi');
    expect(full.indexOf('# Home')).toBeLessThan(full.indexOf('# Tips'));
    expect(full).toContain('Hem body.');
    const capped = llmsFull(settings, pages, 'https://muutto.fi', 250);
    expect(capped).toContain('## More pages');
    expect(capped).toContain('(https://muutto.fi/sv/tips/index.md)');
    expect(new TextEncoder().encode(capped).length).toBeLessThan(1200);
  });
});
