/**
 * A publication that shows every core block type and every page template
 * starter, with the native header and footer, built by the real static
 * renderer. The layout contract reads its HTML at several widths.
 */
import {
  LATEST_RENDER_VERSION, buildCoreBlockRegistry, defaultSiteSettings, newSiteStyles, getPageTemplateStarter, getPartialCompositionStarter, sampleBlockData,
  type Block, type BlockType, type PageTemplateStarterKind,
} from '@typeroll/shared';

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

function sample(type: BlockType, id: string, long = false): Block {
  const data = sampleBlockData(type.schema);
  // Sample data fills numbers with their minimum (a gap of 0px); a new block leaves them unset and uses its defaults.
  for (const field of type.schema ?? []) if (field.type === 'number' && field.default === undefined) delete data[field.name];
  const block: Block = { id, type: type.id, data: long ? lengthen(data, type.schema as Fields) as Record<string, unknown> : data };
  if (type.container === true) {
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
function blockPage(type: BlockType) {
  const slug = slugOf(type.id);
  return {
    id: `block-${slug}`, slug: `block-${slug}`, path: `/blocks/${slug}/`, title: type.name ?? type.id, status: 'published', content_mode: 'blocks',
    blocks: [
      section('alone', [sample(type, 'subject')]),
      section('long', [sample(type, 'subject-long', true)]),
      section('narrow', [{ id: 'grid', type: 'core/grid', data: { columns: 3 }, children: [
        sample(type, 'subject-narrow'), prose('cell-2', '<p>Second cell</p>'), prose('cell-3', `<p>${LONG}</p>`),
      ] }]),
      section('narrow-long', [{ id: 'grid-long', type: 'core/grid', data: { columns: 3 }, children: [
        sample(type, 'subject-narrow-long', true), prose('cell-long-2', '<p>Second cell</p>'), prose('cell-long-3', '<p>Third cell</p>'),
      ] }]),
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
  const pages = [
    textPage,
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
      pages, pageTemplates, media: [], contentTypes: [], blockTypes: [], forms: [],
      partials: (['header', 'footer'] as const).map(kind => ({ id: kind, kind, status: 'published', content_mode: 'blocks',
        blocks: getPartialCompositionStarter(kind, { links }) })),
    },
  };
}
