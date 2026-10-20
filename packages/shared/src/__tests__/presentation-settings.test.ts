// Settings that are accepted but never reach the page.
//
// Each case here was a setting a site could store, preview and publish without
// any effect: a typed value the renderer skipped, a navigation_form value that
// stopped at a replaced field, a button part with no field at all, and a reset
// rule no setting could reach. The last test guards the whole class for every
// core block: a presentation field the renderer writes must be read by CSS.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BLOCKS_RUNTIME_CSS,
  CONTENT_WELL_CSS,
  FORM_SHELL_CSS,
  RENDER_VERSIONS,
  blockFieldTypeWarnings,
  blockOutputForVersion,
  blockTreeWarnings,
  buildCoreBlockRegistry,
  collectBlockAssets,
  fontSmoothingCss,
  renderBlocks,
  renderClientCapabilityScripts,
  integrationConfigKey,
  instanceStyleParts,
  blockPartQuery,
  blockPartsAt,
  blockPartsProblems,
  siteThemeCss,
  defaultSiteSettings,
  type Block,
  type BlockType,
  type FieldDefinition,
} from '../index.js';

import { declarationKey, partSampleBlock, sampleDom, unreachablePresentation } from './presentation-audit.js';
import { UNREACHABLE_PRESENTATION } from './unreachable-presentation.js';

const registry = buildCoreBlockRegistry();
const templateCss = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../site-template/src/styles', name), 'utf8');
const html = (blocks: Block[]) => renderBlocks(blocks, { registry });

describe('typed block field values', () => {
  const tabs = (active_font_weight: unknown): Block => ({ id: 't', type: 'core/tabs', data: { active_font_weight }, slots: [[], []] });

  it('renders a number field written as numeric text', () => {
    expect(html([tabs('600')])).toContain('--active_font_weight:600');
    expect(html([tabs(600)])).toContain('--active_font_weight:600');
    expect(html([tabs({ mobile: '500', desktop: '700' })])).toMatch(/--active_font_weight: 700/);
  });

  it('warns with the field path for a value that still cannot render', () => {
    const warnings = blockFieldTypeWarnings([tabs('bold')], registry);
    expect(warnings).toEqual([expect.objectContaining({
      code: 'field_type_mismatch', path: 'blocks[0].data.active_font_weight', field: 'active_font_weight', expected: 'a number',
    })]);
    expect(blockFieldTypeWarnings([tabs('600')], registry)).toEqual([]);
    // Part of the general write-time report, without passing a registry.
    expect(blockTreeWarnings([tabs('bold')]).map(warning => warning.code)).toContain('field_type_mismatch');
  });

  it('checks responsive values, array items, select options and booleans', () => {
    const block: Block = {
      id: 'n', type: 'core/navigation_form', data: {
        font_size_px: { mobile: 16, desktop: 'large' },
        font: 'serif',
        show_labels: 'false',
        fields: [{ name: 'area', kind: 'number', min: 'ten' }],
      },
    };
    expect(blockFieldTypeWarnings([block], registry).map(warning => warning.path).sort()).toEqual([
      'blocks[0].data.fields[0].min',
      'blocks[0].data.font',
      'blocks[0].data.font_size_px.desktop',
      'blocks[0].data.show_labels',
    ]);
    expect(blockFieldTypeWarnings([block], registry).map(warning => warning.path)).toEqual(expect.arrayContaining([
      'blocks[0].data.font',
      'blocks[0].data.show_labels',
      'blocks[0].data.fields[0].min',
    ]));
  });
});

describe('navigation_form button parts', () => {
  const form = (data: Record<string, unknown>): Block => ({
    id: 'nav', type: 'core/navigation_form',
    data: { destination: '/quote/', button_label: 'Beräkna pris', fields: [{ name: 'address' }], ...data },
  });

  it('renders an icon after the label, hidden from assistive technology', () => {
    const out = html([form({ button_icon: '→', button_icon_size_px: 20 })]);
    expect(out).toContain('Beräkna pris<span class="navigation-button-icon" aria-hidden="true">→</span>');
    expect(out).toContain('--button_icon_size_px:20px');
    // A core icon name becomes the inline icon.
    expect(html([form({ button_icon: 'arrow-right' })])).toMatch(/navigation-button-icon" aria-hidden="true"><svg[^>]*>/);
  });

  it('leaves the button markup unchanged without an icon', () => {
    expect(html([form({})])).toContain('<a data-navigation-fallback href="/quote/">Beräkna pris</a>');
  });

  it('sets the button font weight', () => {
    expect(html([form({ button_font_weight: { mobile: 600, laptop: 700 } })])).toMatch(/--button_font_weight: 700/);
  });
});

describe('address suggestions follow the field they replace', () => {
  const loader = renderClientCapabilityScripts({ [integrationConfigKey('google_places', 'browser_key')]: 'AIza' + 'b'.repeat(35) }, ['address_autocomplete']);
  const script = loader.tags + loader.consentTags;

  it('maps the field contract onto the supported styling surface', () => {
    for (const property of ['--tr-field-min-height', '--tr-field-padding-x', '--tr-field-border-width', '--tr-field-border-color', '--tr-field-radius', '--tr-field-background', '--tr-field-color']) {
      expect(script).toContain(`var(${property}`);
    }
    expect(script).toContain('::part(input)');
    expect(script).toContain('color-scheme:inherit');
    expect(script).toContain("setAttribute('slot','input-icon')");
  });

  it('declares the contract on navigation_form from its own settings', () => {
    const css = collectBlockAssets([{ id: 'n', type: 'core/navigation_form', data: {} }], registry).css;
    for (const [contract, setting] of [
      ['--tr-field-min-height', '--input_height_px'], ['--tr-field-padding-y', '--input_padding_y_px'],
      ['--tr-field-padding-x', '--input_padding_x_px'], ['--tr-field-border-width', '--input_border_width_px'],
      ['--tr-field-border-color', '--navigation-input-border'], ['--tr-field-radius', '--radius_px'],
      ['--tr-field-background', '--navigation-input-bg'], ['--tr-field-color', '--navigation-input-color'],
    ]) expect(css).toContain(`${contract}:var(${setting}`);
  });

  it('drops only the Maps API font stylesheets', () => {
    const pattern = new RegExp(script.match(/GOOGLE_FONTS=\/(.+?)\/;/)![1]);
    expect(pattern.test('https://fonts.googleapis.com/css?family=Roboto:300,400,500,700|Google+Sans:400,500,700')).toBe(true);
    expect(pattern.test('https://fonts.googleapis.com/css?family=Google+Sans+Text:400&text=%E2%86%90')).toBe(true);
    expect(pattern.test('https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap')).toBe(false);
    expect(pattern.test('https://fonts.googleapis.com/css2?family=Sofia%20Sans:wght@400')).toBe(false);
  });
});

describe('font smoothing', () => {
  const theme = (version: number, smoothing?: 'auto' | 'antialiased') =>
    siteThemeCss({ ...defaultSiteSettings, fonts: { ...defaultSiteSettings.fonts, smoothing }, render_version: version });

  it('keeps the reset rule before render version 6 and the browser default from it', () => {
    expect(theme(5)).toContain('-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility');
    expect(theme(6)).not.toContain('font-smoothing');
    expect(theme(6)).not.toContain('text-rendering');
  });

  it('applies an explicit choice on every render version', () => {
    expect(theme(1, 'auto')).not.toContain('font-smoothing');
    expect(theme(6, 'antialiased')).toContain('-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale');
    expect(fontSmoothingCss('unknown', 6)).toBe('');
  });
});

describe('every presentation value a core block writes is read', () => {
  // A css_unit field becomes `--<name>` on the block root. If no CSS reads
  // that variable, the setting is accepted, stored and inert. Known gaps are
  // listed with the reason; a new field cannot join them silently.
  const READ_ELSEWHERE: Record<string, string> = {
    'core/post_card.image_width_percent': 'render-blocks.ts builds card_media_width from it for the row layout',
  };
  const shared = [BLOCKS_RUNTIME_CSS, CONTENT_WELL_CSS, FORM_SHELL_CSS].join('\n');

  for (const { version } of RENDER_VERSIONS.slice(-1)) {
    it(`at render version ${version}`, () => {
      const unread: string[] = [];
      // Any platform CSS may read the variable: repeater-based blocks are
      // styled by the repeater, content slots by the content well.
      const readers = [shared, templateCss('global.css'), ...[...registry.values()].flatMap(type => {
        const { template, styles } = blockOutputForVersion(type, version);
        return [template, styles, type.script ?? ''];
      })].join('\n');
      for (const type of registry.values()) {
        for (const field of type.schema ?? []) {
          if (!field.css_unit || field.min_render_version && field.min_render_version > version) continue;
          const key = `${type.id}.${field.name}`;
          if (READ_ELSEWHERE[key]) continue;
          if (!readers.includes(`var(--${field.name}`)) unread.push(key);
        }
      }
      expect(unread).toEqual([]);
    });
  }
});

describe('every core block field changes what renders', () => {
  // The css_unit check above only sees variables. This one sets each schema
  // field of each core block to a valid value and requires the rendered
  // markup or CSS to change. A field that changes nothing is stored, shown in
  // the editor and inert, which is the defect this file is about.
  const LATEST = RENDER_VERSIONS[RENDER_VERSIONS.length - 1].version;
  const SKIP_TYPES = new Set(['object', 'block_type_ref', 'content_type_ref', 'page_ref', 'page_ref_list', 'global_block', 'style']);

  function sample(field: FieldDefinition, second = false): unknown {
    switch (field.type) {
      case 'number': {
        const min = field.min ?? 0, max = field.max ?? 100;
        let value = Number.isInteger(min) && Number.isInteger(max) && max - min >= 4 ? Math.round((min + max) / 2) : Math.round((min + max) / 2 * 10) / 10;
        if (value === field.default) value = value === min ? max : min;
        return second ? (value === max ? min : max) : value;
      }
      case 'boolean': return second ? field.default === true : field.default !== true;
      case 'select': { const options = (field.options ?? []).filter(option => option !== field.default && option !== ''); return second ? options[1] ?? options[0] : options[0]; }
      case 'multiselect': return (field.options ?? []).slice(0, 1);
      case 'color': return second ? '#654321' : '#123456';
      case 'image': case 'file': return second ? '/media/sample-2.jpg' : '/media/sample.jpg';
      case 'url': return second ? '/sample-2/' : '/sample/';
      case 'email': return 'sample@example.test';
      case 'date': return '2026-01-02';
      case 'datetime': return '2026-01-02T03:04:05Z';
      case 'icon': return second ? 'star' : 'check';
      case 'richtext': return second ? '<p>Sample rich 2</p>' : '<p>Sample rich</p>';
      case 'link': return { url: second ? '/link-2/' : '/link/' };
      case 'array': return [Object.fromEntries((field.fields ?? []).map(sub => [sub.name, sample(sub, second)]))];
      case 'list': case 'list_simple': return [second ? 'Item 2' : 'Item'];
      case 'choices': return [{ value: 'a', label: second ? 'Choice 2' : 'Choice' }];
      default:
        if (/_key$/.test(field.name)) return second ? 'sample-key-2' : 'sample-key';
        if (/country/.test(field.name)) return second ? 'no' : 'se';
        if (/widths$/.test(field.name)) return second ? '2fr 1fr' : '1fr 2fr';
        if (field.name === 'name') return second ? 'data-sample-2' : 'data-sample';
        return `Sample ${field.name}${second ? ' 2' : ''}`;
    }
  }

  /** Data a block needs before its fields can show at all. */
  const BASE: Record<string, Record<string, unknown>> = {
    'core/navigation_form': { destination: '/quote/', fields: [{ name: 'address', kind: 'text', suggest_address: true }] },
    'core/container': { tag: 'a', href: '/x/' },
    'core/icon_box': { link: '/x/' },
    'core/list': { ordered: true, items: [{ html: 'A' }] },
    'core/video': { source: 'url', video_url: 'https://example.test/v.mp4' },
    'core/repeater': { source_type: 'static', item_block: 'core/testimonial', items: [{ quote: 'Q1', name: 'A', group: 'G' }, { quote: 'Q2', name: 'B' }] },
    'core/page_list': { content_type: 'page' },
    'form/radio_group': { choices: [{ value: 'a', label: 'A' }] },
    'form/checkbox_group': { choices: [{ value: 'a', label: 'A' }] },
  };
  /** Fields that only apply when another field has a value. */
  const WHEN: Record<string, Record<string, unknown>> = {
    ...Object.fromEntries(['limit', 'sort_by', 'sort_order', 'filter_field', 'filter_value', 'pinned_ids', 'exclude_current', 'paginate']
      .map(name => [`core/repeater.${name}`, { source_type: 'pages', item_block: 'core/post_card' }])),
    ...Object.fromEntries(['group_sort_order', 'group_heading_level', 'ungrouped_label'].map(name => [`core/repeater.${name}`, { group_by: 'group' }])),
    'core/repeater.empty_state': { items: [] },
    'core/page_list.empty_state': { filter_value: 'nothing-matches' },
    ...Object.fromEntries(['download_behavior', 'download_label'].map(name => [`core/post_card.${name}`, { download_url_field: 'pdf' }])),
    ...Object.fromEntries(['placeholder_icon', 'placeholder_background', 'placeholder_color'].map(name => [`core/post_card.${name}`, { missing_image: 'placeholder' }])),
    ...Object.fromEntries(['autoplay', 'show_arrows', 'show_dots'].map(name => [`core/repeater.${name}`, { layout: 'carousel' }])),
  };
  /** Fields whose effect needs runtime data this test does not model, with where it is tested. */
  const CONTEXT: Record<string, string> = {
    ...Object.fromEntries(['h1_size_px', 'h2_size_px', 'h3_size_px', 'h4_size_px', 'h5_size_px', 'h6_size_px', 'heading_before_px', 'heading_after_px', 'max_width', 'font_size', 'line_height', 'paragraph_spacing', 'rhythm']
      .map(name => [`template_content_slot.${name}`, 'applied when a page is composed into its template (template-blocks tests)'])),
    ...Object.fromEntries(['title', 'fields', 'layout'].map(name => [`core/field_list.${name}`, 'needs the content type field definitions (field-list.test.ts)'])),
    'core/repeater.derived_source': 'needs app-computed derived data (derived-repeater.test.ts)',
    'core/repeater.field': 'needs a page with reference fields (related source)',
    'core/repeater.show_pagination': 'needs archive pagination context',
    'core/post_card.date_field': 'reads a date from the item; the stand-in item answers every date the same',
    'template/page_title.fallback_text': 'shown only when the page has no title',
    'template/page_date.field': 'needs page dates that differ per field',
    'template/page_date.format': 'needs a real page date',
    'template/page_author.show_avatar': 'needs an author with an avatar',
    'template/page_author.prefix': 'needs an author',
    'template/page_author.part_styles': 'needs an author (presentation-audit PART_SAMPLE_CONTEXTS)',
    'template/site_logo.link_to_home': 'needs a site logo',
    'template/show_if.condition': 'needs page values the condition can test',
    ...Object.fromEntries(['text', 'email', 'phone', 'url', 'number', 'textarea', 'select', 'radio_group', 'boolean', 'checkbox_group', 'toggle', 'slider', 'date', 'consent']
      .map(name => [`form/${name}.required_message`, 'the form\'s validation message for a required field (form-fields.ts, tested in form-fields.test.ts); not part of the field markup'])),
  };
  /**
   * Fields that are accepted and never rendered. Each is a defect: fix it and
   * remove the entry (the test fails while an entry here renders).
   */
  const KNOWN_DEAD: Record<string, string> = {
    // Empty: core/video, core/hero.video_url, core/testimonial.rating,
    // core/form.submit_label and the carousel controls render from
    // render version 7 / Core 0.2.79.
  };

  const answering = (prefix: string): Record<string, unknown> => new Proxy({ title: `${prefix} title`, url: `/${prefix}/`, content_mode: 'blocks', blocks: [] } as Record<string, unknown>, {
    get: (target, key) => typeof key !== 'string' ? undefined : key in target ? target[key]
      : key === 'fields' ? answering(`${prefix} field`)
      : /url|href|image|avatar|src/.test(key) ? `/${prefix}-${key}/`
      : /^(date|date_published|published_at|updated_at)$/.test(key) ? '2026-01-02T03:04:05Z' : `${prefix} ${key}`,
    has: () => true,
  });
  const pageSource = (config: Record<string, unknown>) => config.filter_value === 'nothing-matches' ? []
    : [1, 2, 3].map(n => ({ id: `p${n}`, title: `Listed ${n} ${JSON.stringify(config)}`, url: `/p${n}/`, excerpt: 'Excerpt' }));
  const formSource = (id: string, block?: { submit_label?: string }) => `<form data-form="${id}" data-label="${block?.submit_label ?? ''}"></form>`;
  const once = (block: Block, context?: Record<string, unknown>) => {
    try {
      return renderBlocks([block], { registry, renderVersion: LATEST, context: context as never, pageSource, formSource })
        + collectBlockAssets([block], registry, { renderVersion: LATEST }).css;
    } catch (error) {
      return `render error: ${(error as Error).message}`;
    }
  };
  // Without context (fallback values show), with a page and an item that
  // answer every field name, and with an empty page.
  const output = (block: Block) => [once(block), once(block, { page: answering('Page'), item: answering('Item') }), once(block, { page: {}, item: {} })].join('\n----\n');

  function base(type: BlockType, extra: Record<string, unknown> = {}): Block {
    const data: Record<string, unknown> = { ...(BASE[type.id] ?? {}), ...extra };
    for (const field of type.schema ?? []) if (field.required && field.default === undefined && !(field.name in data)) data[field.name] = sample(field);
    const child = (): Block => ({ id: 'child', type: 'core/prose', data: { html: '<p>Child</p>' } });
    const block: Block = { id: 'b', type: type.id, data };
    if (type.container === true) block.children = [child()];
    if (type.container === 'slots') block.slots = Array.from({ length: type.slot_count ?? type.slot_labels?.length ?? 2 }, () => [child()]);
    return block;
  }

  it(`at render version ${LATEST}`, () => {
    const inert: string[] = [];
    const revived: string[] = [];
    for (const type of registry.values()) {
      for (const field of type.schema ?? []) {
        const key = `${type.id}.${field.name}`;
        if (SKIP_TYPES.has(field.type) || CONTEXT[key]) continue;
        const block = base(type, WHEN[key]);
        const current = block.data?.[field.name];
        let value = field.type === 'part_styles' ? { [instanceStyleParts(type, LATEST)[0]!.name]: 'sample-style' }
          : sample(field, field.required === true && field.default === undefined);
        if (JSON.stringify(value) === JSON.stringify(current)) value = sample(field, true);
        if (value === undefined) continue;
        const changed = output(block) !== output({ ...block, data: { ...block.data, [field.name]: value } });
        if (!changed && !KNOWN_DEAD[key]) inert.push(key);
        if (changed && KNOWN_DEAD[key]) revived.push(key);
      }
    }
    expect(inert, 'fields that change nothing when set').toEqual([]);
    expect(revived, 'KNOWN_DEAD entries that now render: remove them').toEqual([]);
  });
});

describe('every presentational value a core block writes is reachable', () => {
  // A literal in a block's CSS (a link underline, an eyebrow's tracking, a
  // button radius) that no field, style or variable reaches can only be
  // changed with site CSS against platform markup. Each must read a
  // variable, style an element a style reaches (a declared part, the style
  // element) with a property a style sets, or be listed in
  // UNREACHABLE_PRESENTATION with a reason. Blocks without parts yet are
  // listed whole; declaring parts (docs/plans/block-parts.md) removes their
  // entries, and a stale entry fails here so the list stays true.
  const LATEST = RENDER_VERSIONS[RENDER_VERSIONS.length - 1].version;

  it(`at render version ${LATEST}`, () => {
    const added: string[] = [];
    const stale: string[] = [];
    for (const type of registry.values()) {
      const found = new Set(unreachablePresentation(type, partSampleBlock(type), registry, LATEST).map(declarationKey));
      const listed = UNREACHABLE_PRESENTATION[type.id] ?? {};
      for (const key of found) if (!listed[key]) added.push(`${type.id}: ${key}`);
      for (const key of Object.keys(listed)) if (!found.has(key)) stale.push(`${type.id}: ${key}`);
    }
    expect(added, 'declare a part for these elements (docs/plans/block-parts.md), read a variable, or list them in UNREACHABLE_PRESENTATION with a reason').toEqual([]);
    expect(stale, 'reachable now or no longer in the CSS: remove them from UNREACHABLE_PRESENTATION').toEqual([]);
  });

  it('lists only core blocks, each entry with a reason', () => {
    for (const [id, entries] of Object.entries(UNREACHABLE_PRESENTATION)) {
      expect(registry.has(id), id).toBe(true);
      for (const [key, reason] of Object.entries(entries)) expect(reason.trim().length, `${id}: ${key}`).toBeGreaterThan(10);
    }
  });

  it('every declared part matches an element in the sample markup', () => {
    const missing: string[] = [];
    for (const { version } of RENDER_VERSIONS) {
      for (const type of registry.values()) {
        const parts = blockPartsAt(type, version);
        if (!parts.length) continue;
        const dom = sampleDom(partSampleBlock(type), registry, version);
        for (const part of parts) if (!dom?.root.querySelector(blockPartQuery(part.selector))) missing.push(`${type.id}.${part.name}@v${version}: ${part.selector}`);
      }
    }
    expect(missing, 'fix the selector, give the part a min_render_version, or extend PART_SAMPLES so the sample renders it').toEqual([]);
  });

  it('declares valid parts whose style fields exist', () => {
    for (const type of registry.values()) {
      expect(blockPartsProblems(type.parts, type.schema), type.id).toEqual([]);
      const hasField = type.schema.some(field => field.name === 'part_styles');
      expect(hasField, `${type.id} has the part_styles field exactly when an instance can style a part`).toBe(instanceStyleParts(type, LATEST).length > 0);
    }
  });
});

describe('platform base CSS has no unreachable opinions', () => {
  // reset.css and global.css apply to every site. A declaration there on a
  // bare element selector (body, a, h1, button, …) changes every page, and
  // unless it reads a variable no setting can reach it; font smoothing was
  // one. Declarations must be a neutral reset, read a variable a setting or
  // style sets, or be listed below with how a site changes it.
  const NEUTRAL = new Set([
    'box-sizing:border-box', 'margin:0', 'height:100%', 'min-height:100%', 'display:block', 'max-width:100%', 'height:auto',
    'font:inherit', 'overflow-wrap:break-word', 'background:none', 'border:0', 'cursor:pointer', 'color:inherit',
  ]);
  const DELIBERATE: Record<string, string> = {
    'body|line-height:1.5': 'outside page content only; the Body text style sets --body-leading for content',
    'a|text-decoration:none': 'navigation and controls; text blocks underline links through --link-decoration (Link style)',
    'h1, h2, h3, h4, h5, h6|line-height:1.2': 'overridden per level by --hN-leading (heading styles) in the rules below it',
  };

  function declarations(css: string): Array<{ selector: string; declaration: string }> {
    const out: Array<{ selector: string; declaration: string }> = [];
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of flat.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const part of body.split(';')) {
        const [property, ...rest] = part.split(':');
        if (!property?.trim() || !rest.length) continue;
        out.push({ selector: selector.trim().replace(/\s+/g, ' '), declaration: `${property.trim()}:${rest.join(':').trim()}` });
      }
    }
    return out;
  }

  it('in reset.css and global.css', () => {
    const unreachable: string[] = [];
    const used = new Set<string>();
    for (const file of ['reset.css', 'global.css']) {
      for (const { selector, declaration } of declarations(templateCss(file))) {
        // Class, attribute and :where() rules are opt-in or zero-specificity.
        if (/[.[]|:where\(/.test(selector)) continue;
        if (declaration.startsWith('--') || declaration.includes('var(') || NEUTRAL.has(declaration)) continue;
        const key = `${selector}|${declaration}`;
        if (DELIBERATE[key]) { used.add(key); continue; }
        unreachable.push(`${file}: ${key}`);
      }
    }
    expect(unreachable, 'make it a setting or a style variable, or list it in DELIBERATE with how a site changes it').toEqual([]);
    expect(Object.keys(DELIBERATE).filter(key => !used.has(key)), 'stale DELIBERATE entries').toEqual([]);
  });
});
