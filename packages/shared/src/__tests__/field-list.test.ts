import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlock, collectBlockAssets } from '../render-blocks.js';
import { DEFAULT_CONTENT_TYPE, pageContentValues, publicContentPage } from '../page-content-model.js';
import { createPageSource } from '../page-source.js';
import { reviewBlockComposition } from '../composition-review.js';
import { SITE_TEMPLATE_CAPABILITIES } from '../site-template-capabilities.js';
import type { Block, ContentType, FieldDefinition, Page } from '../types.js';
const registry = buildCoreBlockRegistry();
const type: ContentType = { ...DEFAULT_CONTENT_TYPE, id: 'facts', name: 'facts', fields: [
  { name: 'website', type: 'url', label: 'Website' },
  { name: 'hq', type: 'text', label: 'Headquarters' },
  { name: 'employees', type: 'number', label: 'Employees' },
  { name: 'delivery', type: 'boolean', label: 'Delivery' },
  { name: 'returns', type: 'textarea', label: 'Returns' },
  { name: 'payment', type: 'select', label: 'Payment', options: ['invoice'], option_labels: ['Invoice'] },
  { name: 'regions', type: 'multiselect', label: 'Regions', options: ['north', 'south'], option_labels: ['North', 'South'] },
  { name: 'parent', type: 'page_ref', label: 'Parent', ref_content_type: 'facts' },
  { name: 'partners', type: 'page_ref_list', label: 'Partners' },
  { name: 'shipping', type: 'text', label: 'Shipping' },
  { name: 'private_status', type: 'text', label: 'Private status', rendered: false },
] };
const block: Block = { id: 'facts', type: 'core/field_list', data: { title: 'At a glance', layout: 'two-column', fields: type.fields.slice(0, 10).map(f => ({ field: f.name })) } };
const page = (id: string, fields: Record<string, unknown> = {}, extra: Partial<Page> = {}): Page => ({ id, title: id, slug: id, content_type: type.id, content_mode: 'blocks', status: 'published', fields, blocks: [], ...extra });
function render(fields: Record<string, unknown>, data = block.data, definitions: FieldDefinition[] = type.fields, pages: Page[] = []) {
  return renderBlock({ ...block, data }, { registry, context: { page: pageContentValues(page('one', fields)), content_type: { ...type, fields: definitions }, pagination: { current: 1, base_url: '/', trailing_slash: 'never' } }, pageSource: createPageSource([type], pages) });
}
const dom = (html: string) => { const w = new Window(); w.document.body.innerHTML = html; return w.document; };

describe('native Page field lists', () => {
  it('renders exactly four of ten rows and omits every empty label from the HTML', () => {
    const html = render({ website: 'https://example.test', hq: 'Oslo', employees: 0, delivery: false, returns: null, payment: '', regions: [], parent: '', partners: [], shipping: '  ' });
    const doc = dom(html);
    expect([...doc.querySelectorAll('dt')].map(x => x.textContent)).toEqual(['Website', 'Headquarters', 'Employees', 'Delivery']);
    expect([...doc.querySelectorAll('dd')].map(x => x.textContent)).toEqual(['https://example.test', 'Oslo', '0', 'False']);
    expect(doc.querySelectorAll('h2')).toHaveLength(1);
    expect(doc.querySelector('[data-layout="two-column"]')).not.toBeNull();
  });
  it('omits the entire section and heading when every selected field is empty or invalid', () => {
    expect(render({ delivery: null, employees: '', regions: [' ', ''], partners: [], website: 'javascript:alert(1)' })).toBe('');
    expect(render({ delivery: 'false', employees: NaN })).toBe('');
    expect(render({ delivery: true })).toContain('<dd>True</dd>');
  });
  it('uses field labels, overrides and option labels without mutating data', () => {
    const values = { payment: 'invoice', regions: ['north', 'south'], hq: 'Paris' };
    const before = structuredClone(values);
    const doc = dom(render(values, { ...block.data, fields: [{ field: 'hq', label: 'Based in' }, { field: 'payment' }, { field: 'regions' }] }));
    expect([...doc.querySelectorAll('dt')].map(x => x.textContent)).toEqual(['Based in', 'Payment', 'Regions']);
    expect(doc.querySelectorAll('li')).toHaveLength(2);
    expect(doc.body.textContent).toContain('Invoice');
    expect(doc.body.textContent).toContain('NorthSouth');
    expect(values).toEqual(before);
  });
  it('resolves only published reference targets, preserving selected order and URL policy', () => {
    const pages = [page('alpha', {}, { title: 'Alpha & Co', path: '/custom/alpha/' }), page('beta'), page('draft', {}, { status: 'draft' }), page('hidden', {}, { status: 'unlisted' })];
    const doc = dom(render({ parent: 'alpha', partners: ['beta', 'missing', 'draft', 'hidden', 'alpha', 'beta'] }, block.data, type.fields, pages));
    expect([...doc.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent])).toEqual([['/custom/alpha', 'Alpha & Co'], ['/beta', 'beta'], ['/custom/alpha', 'Alpha & Co']]);
    expect(render({ parent: 'draft', partners: ['missing'] }, block.data, type.fields, pages)).toBe('');
    expect(render({ parent: 'alpha' }, block.data, type.fields.map(f => f.name === 'parent' ? { ...f, ref_content_type: 'other' } : f), pages)).toBe('');
  });
  it('never emits private or undeclared fields even with an unfiltered context', () => {
    expect(render({ private_status: 'SECRET', absent: 'LEAK', _internal: 'HIDDEN' }, { title: 'Private', show_empty: true, fields: [{ field: 'private_status' }, { field: 'absent' }, { field: '_internal' }] })).toBe('');
    const context = { page: pageContentValues(publicContentPage(page('p', { hq: 'Public', private_status: 'SECRET' }), type)), content_type: { ...type } };
    expect(renderBlock({ ...block, data: { fields: [{ field: 'hq' }, { field: 'private_status' }] } }, { registry, context })).not.toContain('SECRET');
  });
  it('escapes labels, titles and values and rejects unsafe link schemes', () => {
    const html = render({ hq: '<img src=x onerror=evil()>', website: 'data:text/html,evil' }, { title: '<svg onload=evil()>', fields: [{ field: 'hq', label: '<script>evil()</script>' }, { field: 'website' }] });
    const doc = dom(html);
    expect(doc.querySelector('img, script, svg, a')).toBeNull();
    expect(doc.querySelector('dd')?.textContent).toBe('<img src=x onerror=evil()>');
    for (const website of ['//evil.test', '/\\evil.test', 'https://user:password@example.test', 'java\nscript:alert(1)']) expect(render({ website })).toBe('');
  });
  it('updates the template output from Page fields without rewriting body or template blocks', () => {
    const current = page('p', { hq: 'Stockholm' });
    const context = () => ({ page: pageContentValues(current), content_type: { ...type } });
    const before = structuredClone(block);
    expect(renderBlock(block, { registry, context: context() })).toContain('Stockholm');
    current.fields!.hq = '';
    expect(renderBlock(block, { registry, context: context() })).toBe('');
    current.fields!.delivery = false;
    expect(renderBlock(block, { registry, context: context() })).toContain('<dt>Delivery</dt><dd>False</dd>');
    expect(current.blocks).toEqual([]);
    expect(block).toEqual(before);
  });
  it('uses the normal editor annotation and style collection paths', () => {
    const html = renderBlock(block, { registry, context: { page: pageContentValues(page('p', { hq: 'Rome' })), content_type: { ...type } }, annotate: true });
    expect(html).toContain('data-block-id="facts"');
    expect(collectBlockAssets([block], registry).css).toContain('[data-block="field_list"]');
    expect(registry.get('core/field_list')?.schema.find(f => f.name === 'fields')?.fields?.map(f => f.name)).toEqual(['field', 'label', 'html', 'css', 'css_class', 'item_html', 'item_links']);
  });
  it('presents each selected checkbox with custom markup and links only configured option labels', () => {
    const data = { fields: [{ field: 'regions', css_class: 'region-checks',
      item_html: '<span class="checked-box" aria-hidden="true">☑</span><span>{{value}}</span>',
      item_links: [{ value: 'north', url: '/regions/north/' }, { value: 'south', url: 'javascript:evil()' }],
    }] };
    const doc = dom(render({ regions: ['north', 'south', 'north'] }, data));
    expect(doc.querySelectorAll('li')).toHaveLength(2);
    expect(doc.querySelectorAll('.checked-box')).toHaveLength(2);
    expect(doc.querySelectorAll('a')).toHaveLength(1);
    expect(doc.querySelector('a')?.textContent).toBe('North');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('/regions/north/');
    expect([...doc.querySelectorAll('li')].map(li => li.textContent)).toEqual(['☑North', '☑South']);
    expect(render({ regions: [] }, data)).toBe('');
  });
  it('customizes individual rows while preserving labels, safe values and empty/private omission', () => {
    const data = { title: 'Facts', fields: [
      { field: 'payment', html: '<dt>{{label}}</dt><dd><span class="badge">{{value}}</span></dd>', css: 'padding: 1rem; color: navy;', css_class: 'payment-row' },
      { field: 'hq', html: '<dt>{{label}}</dt><dd>{{value}} / {{page.private_status}}</dd>' },
      { field: 'shipping', html: '<dt>Always visible?</dt><dd>Placeholder</dd>' },
      { field: 'private_status', html: '<dt>Leak?</dt><dd>{{value}}</dd>' },
    ] };
    const html = render({ payment: 'invoice', hq: '{{page.private_status}} <img src=x onerror=evil()>', private_status: 'SECRET' }, data);
    const doc = dom(html);
    expect(doc.querySelector('.payment-row .badge')?.textContent).toBe('Invoice');
    expect(doc.querySelector('.payment-row')?.getAttribute('style')).toBe('padding: 1rem; color: navy;');
    expect(doc.querySelectorAll('dt')).toHaveLength(2);
    expect(doc.querySelector('img')).toBeNull();
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('Placeholder');
    expect(html).not.toContain('Leak?');
    expect(html).toContain('{{page.private_status}}');
  });
  it('advertises its capability and reports referenced fields to composition review', () => {
    expect(SITE_TEMPLATE_CAPABILITIES.supports_page_field_list).toBe(true);
    const review = reviewBlockComposition({ name: 'Profile', fields: [{ name: 'hq' }], blocks: [{ ...block, data: { fields: [{ field: 'hq' }, { field: 'missing' }] } }] }, registry);
    expect(review.required_capabilities).toContain('supports_page_field_list');
    expect(review.required_fields).toEqual(['hq', 'missing']);
    expect(review.missing_fields).toEqual(['missing']);
  });
});
