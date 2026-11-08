/**
 * Render version 16 settings and CSS hooks of the navigation and form blocks:
 * each renders as intended at 16 and leaves older versions as they were.
 */
import { describe, it, expect } from 'vitest';
import {
  blockOutputForVersion,
  blockPartsAt,
  buildCoreBlockRegistry,
  collectBlockAssets,
  FORM_SHELL_CSS,
  formShellCss,
  formStepBodyHtml,
  renderBlocks,
  renderFormHtml,
} from '../index.js';
import type { Block, Form } from '../types.js';

const registry = buildCoreBlockRegistry();
const render = (block: Block, renderVersion: number, language?: string) =>
  renderBlocks([block], { registry, renderVersion, ...(language ? { context: { site: { language } } } : {}) });
const css = (type: string, renderVersion: number) => blockOutputForVersion(registry.get(type)!, renderVersion).styles;

describe('core/navigation_form at render version 16', () => {
  const block: Block = {
    id: 'n1', type: 'core/navigation_form',
    data: { destination: '/q/', columns: '2', column_widths: { mobile: '1fr', laptop: '1fr 180px' }, button_column: 'full', fields: [{ name: 'a', column: 'full' }, { name: 'b' }] },
  };

  it('layers its layout and selects the block by attribute, not by ID', () => {
    const html = render(block, 16);
    expect(html).toContain('<style>@layer typeroll.instance{\n[id="navigation-n1"]{grid-template-columns:minmax(0,1fr)}');
    expect(html).toContain('@media(min-width:1024px){[id="navigation-n1"]{grid-template-columns:minmax(0,1fr) 180px}}');
    expect(html).toContain('[id="navigation-n1"] [data-navigation-field="a"]{grid-column:1 / -1}');
    expect(html).toContain('[id="navigation-n1"] .navigation-actions{grid-column:1 / -1}');
    expect(html).not.toContain('#navigation-n1');
  });

  it('keeps the unlayered ID rules below 16', () => {
    const html = render(block, 15);
    expect(html).toContain('<style>#navigation-n1 {grid-template-columns:minmax(0,1fr)}');
    expect(html).not.toContain('[id="navigation-n1"]');
  });

  it('takes a maximum width and an alignment', () => {
    const html = render({ ...block, data: { ...block.data, max_width_px: 480, align: 'center' } }, 16);
    expect(html).toContain('data-align="center"');
    expect(html).toContain('--max_width_px:480px');
    expect(css('core/navigation_form', 16)).toContain('[data-block="navigation_form"]{max-inline-size:var(--max_width_px,none)}');
    expect(css('core/navigation_form', 16)).toContain('[data-block="navigation_form"][data-align="center"]{margin-inline:auto}');
    expect(render(block, 16)).toContain('data-align="start"');
    expect(render({ ...block, data: { ...block.data, align: 'center' } }, 15)).not.toContain('data-align');
    expect(css('core/navigation_form', 15)).not.toContain('data-align');
  });
});

describe('core/navigation_menu at render version 16', () => {
  it('shows a localized label beside the menu symbol when asked', () => {
    const html = render({ id: 'm', type: 'core/navigation_menu', data: { show_toggle_label: true } }, 16, 'sv');
    expect(html).toContain('<path d="M3 6h18M3 12h18M3 18h18"/></svg><span class="block-menu-open-label">Meny</span></button>');
    expect(render({ id: 'm', type: 'core/navigation_menu', data: { show_toggle_label: true, toggle_label: 'Browse' } }, 16)).toContain('<span class="block-menu-open-label">Browse</span>');
    expect(render({ id: 'm', type: 'core/navigation_menu', data: {} }, 16)).not.toContain('block-menu-open-label');
    expect(render({ id: 'm', type: 'core/navigation_menu', data: { show_toggle_label: true } }, 15)).not.toContain('block-menu-open-label');
  });

  it('positions and colours the menu button', () => {
    const html = render({ id: 'm', type: 'core/navigation_menu', data: { toggle_align: 'end', toggle_color: '#ff0000' } }, 16);
    expect(html).toContain('data-toggle-align="end"');
    expect(html).toContain('--menu-toggle-color:#ff0000');
    const styles = css('core/navigation_menu', 16);
    expect(styles).toContain('[data-block="navigation_menu"] > .block-menu-open { color:var(--menu-toggle-color,inherit); }');
    expect(styles).toContain('[data-block="navigation_menu"][data-toggle-align="end"] > .block-menu-open { margin-inline-start:auto; }');
    expect(styles).not.toContain('!important');
    expect(render({ id: 'm', type: 'core/navigation_menu', data: { toggle_align: 'end' } }, 15)).not.toContain('data-toggle-align');
  });

  it('names its button, close button, panel and content as parts from 16', () => {
    const type = registry.get('core/navigation_menu')!;
    expect(blockPartsAt(type, 16).map(part => part.name)).toEqual(['open_button', 'close_button', 'panel', 'content']);
    expect(blockPartsAt(type, 15)).toEqual([]);
  });
});

describe('core/navigation_links at render version 16', () => {
  it('aligns a row of links', () => {
    const block: Block = { id: 'l', type: 'core/navigation_links', data: { direction: 'row', justify: 'space-between', links: [{ label: 'A', href: '/a' }] } };
    expect(render(block, 16)).toContain('--justify:space-between');
    expect(render({ ...block, data: { ...block.data, group_label: 'Explore' } }, 16)).toContain('--justify:space-between');
    expect(css('core/navigation_links', 16)).toContain('[data-block="navigation_links"], [data-block="navigation_links"] > .block-nav-list { justify-content:var(--justify,normal); }');
    expect(render(block, 15)).not.toContain('--justify');
    expect(css('core/navigation_links', 15)).not.toContain('--justify');
  });
});

describe('form steps at render version 16', () => {
  const step = {
    id: 's1',
    blocks: [
      { id: 'b1', type: 'form/text', data: { name: 'first', label: 'First name', width: 'half' } },
      { id: 'b2', type: 'form/text', data: { name: 'last', label: 'Last name', width: 'half' } },
      { id: 'b3', type: 'form/boolean', data: { name: 'ok', label: 'OK?' } },
      { id: 'b4', type: 'form/radio_group', data: { name: 'r', label: 'R', direction: 'row', choices: [{ value: 'a', label: 'A' }] } },
      { id: 'b5', type: 'form/heading', data: { text: 'Contact', description: 'Intro' } },
    ] as Block[],
  };

  it('renders the step blocks at the baseline version before 16, exactly as before', () => {
    for (const version of [1, 5, 15]) {
      expect(formStepBodyHtml(step, registry, version, 'sv')).toBe(renderBlocks(step.blocks, { registry }));
    }
    const html = formStepBodyHtml(step, registry, 15, 'sv');
    expect(html).toContain('> Yes</label>');
    expect(html).not.toContain('data-width');
  });

  it('renders them at the site version from 16, with widths, directions and classes', () => {
    const html = formStepBodyHtml(step, registry, 16, 'en');
    expect(html).toContain('data-field="first" data-width="half"');
    expect(html).toContain('data-field="r" data-width="full" data-direction="row"');
    expect(html).toContain('<h3 class="form-section-title">Contact</h3>');
    expect(html).toContain('<p class="form-section-description">Intro</p>');
    expect(html).toContain('<label class="form-boolean-choice">');
    expect(html).toContain('<span class="form-boolean-text">Yes</span>');
    expect(html).toContain('<button type="button" class="form-boolean-clear" data-clear-answer="ok">Clear answer</button>');
    expect(css('form/radio_group', 16)).toContain('[data-block="form_radio_group"][data-direction="row"] { flex-flow: row wrap; column-gap: 1.25rem; }');
    expect(css('form/checkbox_group', 16)).toContain('[data-block="form_checkbox_group"][data-direction="row"]');
    expect(css('form/radio_group', 15)).not.toContain('data-direction');
  });

  it("speaks the site's language in a Yes / No answer, keeping the site's own texts", () => {
    const sv = formStepBodyHtml(step, registry, 16, 'sv');
    expect(sv).toContain('<span class="form-boolean-text">Ja</span>');
    expect(sv).toContain('<span class="form-boolean-text">Nej</span>');
    expect(sv).toContain('>Rensa svaret</button>');
    // The English defaults an editor may have stored count as unset.
    const stored = { id: 's2', blocks: [{ id: 'b', type: 'form/boolean', data: { name: 'x', label: 'X', yes_label: 'Yes', no_label: 'Absolutely not' } }] as Block[] };
    const html = formStepBodyHtml(stored, registry, 16, 'sv');
    expect(html).toContain('>Ja</span>');
    expect(html).toContain('>Absolutely not</span>');
    // Nested in a container too.
    const nested = { id: 's3', blocks: [{ id: 'c', type: 'core/container', data: {}, children: stored.blocks }] as Block[] };
    expect(formStepBodyHtml(nested, registry, 16, 'sv')).toContain('>Ja</span>');
  });

  it('ships the form field CSS of version 16 with the field blocks', () => {
    const assets = collectBlockAssets(step.blocks, registry, { renderVersion: 16 });
    expect(assets.css).toContain('[data-block="form_radio_group"][data-direction="row"]');
  });
});

describe('the form shell at render version 16', () => {
  const form = { id: 'f1', steps: [{ id: 's1', blocks: [{ id: 'b1', type: 'form/text', data: { name: 'first', label: 'First' } }] }] } as unknown as Form;
  const embed = { submit_url: '/s', submit_token: 't' };

  it('takes the core/form block settings for its width, alignment and submit button', () => {
    const html = renderFormHtml(form, embed, { registry, renderVersion: 16, align: 'center', submit_align: 'end', submit_width: 'full', max_width_px: 520 });
    expect(html).toContain('data-tr-context-params="[]" data-align="center" data-submit-align="end" data-submit-width="full" style="--form-max-width:520px">');
    expect(html).toContain('<div class="form-actions"><button type="submit" class="form-submit">Send</button></div>');
  });

  it('adds nothing for defaults or unknown values', () => {
    const html = renderFormHtml(form, embed, { registry, renderVersion: 16, align: 'start', submit_align: 'left', submit_width: 'auto', max_width_px: 'wide' });
    expect(html).toContain('data-tr-context-params="[]">');
    expect(renderFormHtml(form, embed, { registry, renderVersion: 16, max_width_px: 10 })).not.toContain('--form-max-width');
  });

  it('leaves older versions as they were', () => {
    const html = renderFormHtml(form, embed, { registry, renderVersion: 15, align: 'center', submit_width: 'full', max_width_px: 520 });
    expect(html).toContain('data-tr-context-params="[]">');
    expect(html).not.toContain('form-actions');
    expect(html).toContain('<div data-form-dynamic-step hidden></div>\n<button type="submit" class="form-submit">Send</button>');
  });

  it('adds the layout rules to the shell CSS from 16 only, without !important', () => {
    expect(formShellCss(15)).toBe(FORM_SHELL_CSS);
    expect(formShellCss(undefined)).toBe(FORM_SHELL_CSS);
    const added = formShellCss(16).slice(FORM_SHELL_CSS.length);
    expect(added).toContain('[data-tr-form] { max-inline-size: var(--form-max-width, none); }');
    expect(added).toContain('[data-tr-form][data-submit-width="full"] .form-submit');
    expect(added).toContain('> .form-field[data-width="half"] { flex-basis: calc(50% - var(--form-column-gap) / 2); }');
    expect(added).not.toContain('!important');
  });
});
