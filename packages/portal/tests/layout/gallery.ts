/**
 * A publication that shows every core block type and every page template
 * starter, with the native header and footer, built by the real static
 * renderer. The layout contract reads its HTML at several widths.
 */
import {
  LATEST_RENDER_VERSION, buildCoreBlockRegistry, defaultSiteSettings, newSiteStyles, getPageTemplateStarter, getPartialCompositionStarter, openingHoursField, sampleBlockData,
  type Block, type BlockType, type PageTemplateStarterKind,
} from '@typeroll/shared';
import { demoImage } from './demo-media';

const LONG = 'Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung';
// Blocks that need context the gallery does not have yet: a form definition,
// a page being rendered through a template, or a global block source. Their
// layouts are covered by the template pages and by later phases.
const SKIPPED = (type: BlockType) => type.id.startsWith('form/') || type.id.startsWith('template/')
  || ['template_content_slot', 'core/global_block', 'core/form', 'core/navigation_form'].includes(type.id);
const TEMPLATES: PageTemplateStarterKind[] = ['blog', 'article', 'checklist', 'team', 'events', 'products', 'profile', 'landing'];

export const slugOf = (id: string) => id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

const SENTENCE = 'Plan, write and publish a site your whole team can keep up to date';
/** Replace short placeholder text in text fields (never options, links or media) with realistic, longer text, including one unbreakable word. */
type Fields = readonly { name: string; type: string; fields?: Fields }[] | undefined;
function lengthen(value: unknown, fields: Fields): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields ?? []) {
    const current = out[field.name];
    if (field.type === 'array' && Array.isArray(current)) out[field.name] = current.map(item => lengthen(item, field.fields));
    else if (field.type === 'object') out[field.name] = lengthen(current, field.fields);
    else if (typeof current !== 'string' || !current) continue;
    else if (field.type === 'richtext') out[field.name] = `<p>${SENTENCE}, from the first draft to the published page.</p><p>${LONG}</p>`;
    else if (field.type === 'text' || field.type === 'textarea') out[field.name] = /title|heading|name|label|question/i.test(field.name) ? `${current}: ${SENTENCE}` : `${SENTENCE}. ${LONG}.`;
  }
  return out;
}

/** Fill image fields with real images (a logo for logo fields, a portrait for people), so the gallery shows how blocks hold media. */
function withImages(value: Record<string, unknown>, fields: Fields, type: string): Record<string, unknown> {
  const out = { ...value };
  for (const field of fields ?? []) {
    if (field.type === 'image') out[field.name] = /logo/.test(field.name) || type === 'core/logo_item' || type === 'core/logo_cloud' ? demoImage('logo-2')
      : /avatar|photo|portrait/.test(field.name) || /team|testimonial/.test(type) ? demoImage('person-1') : demoImage('interior-1');
    else if (field.type === 'array' && Array.isArray(out[field.name])) out[field.name] = (out[field.name] as unknown[]).map(item => item && typeof item === 'object' ? withImages(item as Record<string, unknown>, field.fields, type) : item);
  }
  return out;
}

/** Site fields the gallery's Site field and Show if blocks read: a phone number, a booking toggle and a week of opening hours. */
const SITE_FIELDS = {
  groups: [{ id: 'contact', label: 'Contact', fields: [
    { name: 'phone', type: 'text', label: 'Phone' }, { name: 'show_booking', type: 'boolean', label: 'Show booking' }, openingHoursField(),
  ] }],
  values: { phone: '+46 90-12 34 56', show_booking: true, opening_hours: {
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day, index) => index < 5 ? { day, opens: '09:00', closes: '17:00' } : index === 5 ? { day, opens: '10:00', closes: '14:00' } : { day, closed: true }),
    exceptions: [{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }],
  } },
};
/** A dated live snippet, "Today's lunch": the same dish every weekday so the page reads the same whatever day it is built. */
const SNIPPETS = [{ id: 'lunch', kind: 'dated', format: 'html', updated_at: '2026-11-08T08:00:00.000Z', fallback: '<p>No lunch today.</p>',
  entries: [...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(weekday => ({ weekday, content: '<p><strong>Today\'s lunch:</strong> pea soup with pancakes and jam, coffee included.</p>' })),
    { date: '2026-12-24', content: '<p><strong>Christmas Eve:</strong> closed.</p>' }] }];
/**
 * The menus from render version 15: the header's primary menu has a plain
 * submenu and a wide one in columns with headings, the footer its own list.
 */
const MENUS = [
  { id: 'primary', name: 'Primary', locations: ['primary'], items: [
    { id: 'blocks', type: 'url', href: '/', label: 'Blocks', children: [
      { id: 'text', type: 'page', page_id: 'text', description: 'Headings and running text' },
      { id: 'effects', type: 'page', page_id: 'effects', description: 'Motion, media and story blocks' },
      { id: 'variables', type: 'page', page_id: 'variables' },
    ] },
    { id: 'templates', type: 'url', href: '/templates/article/', label: 'Templates', children: [
      { id: 'pages', type: 'heading', label: 'Pages', children: [
        { id: 'article', type: 'url', href: '/templates/article/', label: 'Article', description: 'A long read with a table of contents' },
        { id: 'landing', type: 'url', href: '/templates/landing/', label: 'Landing page' },
      ] },
      { id: 'more', type: 'heading', label: 'More', children: [
        { id: 'events', type: 'url', href: '/templates/events/', label: 'Events' },
        { id: 'team', type: 'url', href: '/templates/team/', label: 'Team' },
      ] },
    ] },
    { id: 'long', type: 'url', href: '/text/', label: 'A longer navigation label' },
  ] },
  { id: 'footer', name: 'Footer', locations: ['footer'], items: [
    { id: 'f-text', type: 'page', page_id: 'text' }, { id: 'f-effects', type: 'page', page_id: 'effects' }, { id: 'f-variables', type: 'page', page_id: 'variables' },
  ] },
];

/** Blocks whose sample data would show nothing without site fields or snippets. */
const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  'core/site_field': { field: 'opening_hours', format: 'auto' },
  'core/show_if': { condition: 'site.fields.show_booking' },
  'core/snippet': { snippet: 'lunch', tag: 'section' },
};

function sample(type: BlockType, id: string, long = false): Block {
  const data = withImages(sampleBlockData(type.schema), type.schema as Fields, type.id);
  // Sample data fills numbers with their minimum (a gap of 0px); a new block leaves them unset and uses its defaults.
  for (const field of type.schema ?? []) if (field.type === 'number' && field.default === undefined) delete data[field.name];
  // Field names and conditions stay as written; labels and other text get longer.
  const block: Block = { id, type: type.id, data: { ...(long ? lengthen(data, type.schema as Fields) as Record<string, unknown> : data), ...SAMPLE_DATA[type.id] } };
  if (type.container === true || type.container === 'conditional') {
    block.children = [
      { id: `${id}-text`, type: 'core/prose', data: { html: '<p>A paragraph inside the block, long enough to wrap on a phone screen.</p>' } },
      { id: `${id}-button`, type: 'core/button', data: { label: 'Primary action', href: '/' } },
    ];
  }
  return block;
}

const section = (id: string, children: Block[], data: Record<string, unknown> = {}): Block =>
  ({ id, type: 'core/section', data: { width: 'wide', ...data }, children });
const prose = (id: string, html: string): Block => ({ id, type: 'core/prose', data: { html } });

/** Each block alone, then in the first cell of a three-column grid, then the content that ends the page. */
/** A caption naming the case a section of a block page shows. */
const label = (id: string, text: string): Block => ({ id: `${id}-case`, type: 'core/prose', data: { html: `<p><small><strong>Case:</strong> ${text}</small></p>` } });

function blockPage(type: BlockType) {
  const slug = slugOf(type.id);
  return {
    id: `block-${slug}`, slug: `block-${slug}`, path: `/blocks/${slug}/`, title: type.name ?? type.id, status: 'published', content_mode: 'blocks',
    blocks: [
      section('alone-case', [label('alone', 'Alone, with its sample content')]),
      section('alone', [sample(type, 'subject')]),
      section('long-case', [label('long', 'With long text in every field')]),
      section('long', [sample(type, 'subject-long', true)]),
      section('narrow-case', [label('narrow', 'In the first of three grid cells, beside other content')]),
      section('narrow', [{ id: 'grid', type: 'core/grid', data: { columns: 3 }, children: [
        sample(type, 'subject-narrow'), prose('cell-2', '<p>Second cell</p>'), prose('cell-3', `<p>${LONG}</p>`),
      ] }]),
      section('narrow-long-case', [label('narrow-long', 'In a grid cell, with long text')]),
      section('narrow-long', [{ id: 'grid-long', type: 'core/grid', data: { columns: 3 }, children: [
        sample(type, 'subject-narrow-long', true), prose('cell-long-2', '<p>Second cell</p>'), prose('cell-long-3', '<p>Third cell</p>'),
      ] }]),
      section('end-case', [label('end', 'The end of a page')]),
      section('end', [prose('end-text', '<p>The last paragraph before the footer.</p>'),
        { id: 'end-actions', type: 'core/container', data: { direction: 'row', wrap: 'wrap', gap: 'sm' }, children: [
          { id: 'end-primary', type: 'core/button', data: { label: 'Start a 30-day trial', href: '/' } },
          { id: 'end-secondary', type: 'core/button', data: { label: 'All comparisons', href: '/', variant: 'ghost' } },
        ] }]),
    ],
  };
}

export function layoutGallery(renderVersion = LATEST_RENDER_VERSION) {
  const registry = buildCoreBlockRegistry();
  const types = [...registry.values()].filter(type => !SKIPPED(type)).sort((a, b) => a.id.localeCompare(b.id));
  const links = [{ label: 'Blocks', href: '/' }, { label: 'Templates', href: '/' }, { label: 'A longer navigation label', href: '/' }];
  const pageTemplates = TEMPLATES.map(kind => ({ id: `starter-${kind}`, name: kind, status: 'published', blocks: getPageTemplateStarter(kind)! }));
  const templatePages = TEMPLATES.map(kind => ({
    id: `template-${kind}`, slug: `template-${kind}`, path: `/templates/${kind}/`, title: `A ${kind} page with a title long enough to wrap`,
    status: 'published', content_mode: 'blocks', template: `starter-${kind}`, excerpt: 'A short excerpt that introduces the page.',
    blocks: [prose('body', `<p>Body text of the ${kind} page.</p><p>${LONG}</p>`)],
  }));
  // Running text with headings at every level, both inside one Text block and as Heading blocks between Text blocks.
  const para = (n: number) => `<p>${SENTENCE}, from the first draft to the published page. Paragraph ${n} continues long enough to wrap on every screen.</p>`;
  const textPage = { id: 'text', slug: 'text', path: '/text/', title: 'Running text', status: 'published', content_mode: 'blocks', blocks: [
    section('prose', [prose('flow', `${para(1)}<h2>A second-level heading in the text</h2>${para(2)}<h3>A third-level heading</h3>${para(3)}<ul><li>${SENTENCE}</li><li>A second item</li></ul><h4>A fourth-level heading</h4>${para(4)}<h2>Another section of the text</h2>${para(5)}`)]),
    section('blocks', [prose('b1', para(6)), { id: 'h2', type: 'core/heading', data: { text: 'A heading block between text blocks', level: 'h2' } }, prose('b2', para(7)),
      { id: 'h3', type: 'core/heading', data: { text: 'A third-level heading block', level: 'h3' } }, prose('b3', para(8))]),
  ] };
  // Motion, background media, text over images and the story blocks, set up as a site would use them.
  const img = (n: 1 | 2 | 3 | 4 | 5 | 6) => demoImage(`project-${n}`);
  const heading = (id: string, text: string, level = 'h2'): Block => ({ id, type: 'core/heading', data: { text, level } });
  const effectsPage = { id: 'effects', slug: 'effects', path: '/effects/', title: 'Motion and media', status: 'published', content_mode: 'blocks', blocks: [
    { id: 'notice', type: 'core/announcement_bar', data: { text: '<p>Open on Saturdays in November</p>', link_url: '/', dismissible: true } },
    { id: 'hero-spot', type: 'core/hero', data: { heading: 'Homes drawn for the light they get', subheading: '<p>Architecture and interiors from first sketch to keys.</p>', layout: 'full-image', image: demoImage('hero'), height: 'half-screen', overlay_style: 'spot', overlay_opacity: 70, text_vertical: 'end', primary_label: 'See projects', primary_url: '/', motion: 'rise' } },
    section('glass', [heading('glass-h', 'Glass over the image'), prose('glass-p', '<p>The plate blurs the part of the picture behind the text, so it reads on any photo.</p>')],
      { background_image: img(1), background_overlay: 10, text_panel: 'dark_glass', text_panel_shape: 'rounded', min_height: 'md', text_position: { mobile: 'bottom-center', laptop: 'center-start' } }),
    section('gradient', [heading('gradient-h', 'Darkening from one side'), prose('gradient-p', '<p>The image stays clear where there is no text.</p>')],
      { background_image: img(3), overlay_style: 'gradient', overlay_side: 'start', background_overlay: 85, min_height: 'sm', text_position: { mobile: 'center-start' } }),
    section('light', [heading('light-h', 'A light plate with an organic shape'), prose('light-p', '<p>Dark text on a see-through light plate.</p>')],
      { background_image: img(2), background_overlay: 0, text_panel: 'light_translucent', text_panel_shape: 'blob', min_height: 'md', text_position: { mobile: 'center', laptop: 'center-end' } }),
    section('band', [heading('band-h', 'A band across the picture')], { background_image: img(5), background_overlay: 0, text_panel: 'band', min_height: 'sm', text_position: { mobile: 'bottom-center' } }),
    section('figures', [heading('figures-h', 'Key figures'), { id: 'stats', type: 'core/stats', data: { motion: 'fade', items: [
      { value: '120', label: 'Homes designed' }, { value: '18', label: 'Years in practice' }, { value: '98 %', label: 'Clients who return', description: 'Survey 2026' }, { value: '1 200', label: 'Square metres a year' },
    ] } }]),
    section('steps', [heading('steps-h', 'How a project runs'), { id: 'scroll-steps', type: 'core/scroll_steps', data: { items: [
      { title: 'Listen', text: '<p>We walk the site with you and write down how you live.</p>', image: img(1), image_alt: 'The site' },
      { title: 'Sketch', text: '<p>Three directions, drawn by hand, priced roughly.</p>', image: img(2), image_alt: 'Sketches' },
      { title: 'Build', text: '<p>We follow the build every week until the keys are yours.</p>', image: img(3), image_alt: 'The finished house' },
    ] } }]),
    { id: 'film', type: 'core/scroll_film', data: { frames: [1, 2, 3, 4, 5, 6].map(n => ({ src: img(n as 1) })), description: 'Six of our projects', length: 'short',
      captions: [{ text: '<p><strong>Six homes</strong>, one way of working.</p>', start: 0, end: 45 }, { text: '<p>Each drawn for its plot and its light.</p>', start: 50, end: 100, align: 'end' }] } },
    section('timeline', [heading('timeline-h', 'Our history'), { id: 'timeline', type: 'core/timeline', data: { layout: 'alternate', motion: 'rise', items: [
      { date: '2008', title: 'The first house', text: '<p>A summer house on Värmdö.</p>' }, { date: '2015', title: 'Interiors', text: '<p>We start drawing interiors too.</p>', image: img(4), image_alt: 'An interior' },
      { date: '2026', title: 'Twelve of us', text: '<p>Architects, interior designers and a project manager.</p>' },
    ] } }]),
    section('compare', [heading('compare-h', 'Before and after'), { id: 'ba', type: 'core/before_after', data: { before_image: img(4), before_alt: 'Before', after_image: img(6), after_alt: 'After', aspect_ratio: '16:9' } }]),
    section('logos', [heading('logos-h', 'Partners'), { id: 'marquee', type: 'core/logo_cloud', data: { layout: 'marquee', items: [1, 2, 3, 4, 5, 6].map(n => ({ src: demoImage(`logo-${n as 1}`), alt: `Partner ${n}` })) } }]),
    section('gallery', [heading('gallery-h', 'Gallery'), { id: 'photos', type: 'core/gallery', data: { motion: 'scale', items: [1, 2, 3, 4, 5, 6].map(n => ({ src: img(n as 1), alt: `Project ${n}`, caption: `Project ${n}` })) } }]),
    section('audio-s', [{ id: 'audio', type: 'core/audio', data: { src: '/demo-media/episode.mp3', title: 'Episode 4: Building with timber', description: '<p>Twenty minutes on why we draw in wood.</p>', cover: img(2), transcript_url: '/' } }]),
    { id: 'cta-glass', type: 'core/cta', data: { heading: 'Book a first walk on your site', subheading: '<p>An hour, free, with one of our architects.</p>', primary_label: 'Book a walk', primary_url: '/', background_image: img(6), image_position: 'background', text_panel: 'dark_glass', text_panel_shape: 'slant', align: 'left', width: 'wide', motion: 'rise' } },
  ] };
  // Authored site variables (render version 15) in text, headings and buttons.
  const variablesPage = { id: 'variables', slug: 'variables', path: '/variables/', title: 'Site variables', status: 'published', content_mode: 'blocks', blocks: [
    section('vars', [
      { id: 'vars-h', type: 'core/heading', data: { text: 'Welcome to {{site.name}}', level: 'h2' } },
      prose('vars-p', '<p>Call us on {{site.fields.phone}}. Every page shows the same number, from the site settings. © {{site.current_year}} {{site.name}}.</p>'),
      { id: 'vars-b', type: 'core/button', data: { label: 'Call {{site.fields.phone}}', href: '/' } },
    ]),
  ] };
  const pages = [
    textPage,
    effectsPage,
    variablesPage,
    { id: 'home', slug: 'home', path: '/', title: 'Layout gallery', status: 'published', content_mode: 'blocks', blocks: [prose('intro', '<p>Gallery</p>')] },
    ...types.map(blockPage), ...templatePages,
  ];
  return {
    pages: pages.map(page => page.path),
    publication: {
      format: 'typeroll-static-publication', format_version: 2, publication_id: 'c'.repeat(64), core_commit: 'c'.repeat(40),
      site_url: 'https://gallery.example.invalid', version_id: 'main', site: { name: 'Layout gallery' },
      // What a new site starts with: default theme values and standard styles.
      settings: { ...structuredClone(defaultSiteSettings), styles: newSiteStyles(), site_name: 'Layout gallery', trailing_slash: 'always', render_version: renderVersion },
      pages, pageTemplates, media: [], contentTypes: [], blockTypes: [], forms: [], siteFields: SITE_FIELDS, snippets: SNIPPETS,
      ...(renderVersion >= 15 ? { menus: MENUS } : {}),
      partials: (['header', 'footer'] as const).map(kind => ({ id: kind, kind, status: 'published', content_mode: 'blocks',
        blocks: getPartialCompositionStarter(kind, { links, renderVersion }) })),
    },
  };
}
