import type { BlockType, FieldDefinition } from './types.js';
import type { RenderBlocksOptions } from './render-blocks.js';
import { applyTrailingSlash } from './url-policy.js';

/** Values remain on the Page; the template stores only field names and presentation. */
export const FIELD_LIST_BLOCK: BlockType = {
  id: 'core/field_list', name: 'field_list', label: 'Page field list', icon: 'list',
  category: 'content', container: false,
  schema: [
    { name: 'title', type: 'text', label: 'Heading (optional)' },
    { name: 'fields', type: 'array', label: 'Fields', fields: [
      { name: 'field', type: 'text', label: 'Content type field name', required: true },
      { name: 'label', type: 'text', label: 'Label override (optional)' },
      { name: 'boolean_display', type: 'select', label: 'Boolean display', options: ['property', 'yes-no'], option_labels: ['Hide false values', 'Show Yes / No'], default: 'property' },
      { name: 'true_label', type: 'text', label: 'True label', default: 'Yes' },
      { name: 'false_label', type: 'text', label: 'False label', default: 'No' },
      { name: 'html', type: 'textarea', label: 'Row HTML (optional)', placeholder: '<dt>{{label}}</dt><dd><span class="badge">{{value}}</span></dd>' },
      { name: 'css', type: 'textarea', label: 'Row CSS declarations (optional)', placeholder: 'padding: 1rem; border-bottom: 1px solid currentColor;' },
      { name: 'css_class', type: 'text', label: 'Row CSS class (optional)' },
      { name: 'item_html', type: 'textarea', label: 'Option / reference HTML (optional)', placeholder: '<span aria-hidden="true">☑</span> {{value}}' },
      { name: 'item_links', type: 'array', label: 'Option links (optional)', fields: [
        { name: 'value', type: 'text', label: 'Stored option value', required: true },
        { name: 'url', type: 'url', label: 'Link URL', required: true },
      ] },
    ] },
    { name: 'layout', type: 'select', label: 'Layout', options: ['stack', 'two-column'], option_labels: ['Stack', 'Two columns'], default: 'stack' },
  ],
  template: '<section data-block="field_list" data-layout="{{layout}}">{{{field_list_html}}}</section>',
  styles: `
[data-block="field_list"] { min-width:0; }
[data-block="field_list"] > h2 { margin:0 0 1rem; }
[data-block="field_list"] > dl { display:grid; grid-template-columns:minmax(0,1fr); gap:.7rem 2rem; margin:0; }
[data-block="field_list"] .field-list-row { min-width:0; overflow-wrap:anywhere; }
[data-block="field_list"] dt { font-weight:600; }
[data-block="field_list"] dd { margin:.25rem 0 0; white-space:pre-line; overflow-wrap:anywhere; }
[data-block="field_list"] ul { margin:0; padding-left:1.25em; }
[data-block="field_list"] ul[data-custom-items="true"] { list-style:none; padding-inline-start:0; }
@media (min-width:640px) { [data-block="field_list"][data-layout="two-column"] > dl { grid-template-columns:repeat(2,minmax(0,1fr)); } }
`.trim(),
  origin: 'core', created_at: '1970-01-01T00:00:00Z',
};

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/** Only inert web links; no executable schemes, protocol-relative URLs or credentials. */
function webUrl(value: unknown): string {
  const url = text(value);
  if (!url || /[\u0000-\u0020\\]/.test(url)) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : '';
  } catch { return ''; }
}

/** The shared preview/static renderer supplies escaping and its published Page source. */
export function renderFieldList(
  data: Record<string, unknown>,
  options: RenderBlocksOptions,
  escape: (value: unknown) => string,
): string {
  const definitions = options.context?.content_type?.fields;
  const values = options.context?.page?.fields;
  if (!Array.isArray(definitions) || !record(values) || !Array.isArray(data.fields)) return '';
  const schema = new Map<string, FieldDefinition>(definitions.filter(record).map(field => [String(field.name), field as unknown as FieldDefinition]));
  const list = (items: string[], custom: boolean) => items.length ? `<ul class="field-list-values" data-custom-items="${custom}">${items.map(item => `<li>${item}</li>`).join('')}</ul>` : '';
  const present = (template: string, label: string, value: string) => template.replace(/\{\{\s*(label|value)\s*\}\}/g,
    (_match, token: string) => token === 'label' ? escape(label) : value);
  function valueHtml(field: FieldDefinition, value: unknown, row: Record<string, unknown>): string {
    const item = (label: string, value: string) => present(text(row.item_html) || '{{value}}', label, value);
    switch (field.type) {
      case 'text': case 'textarea': return escape(text(value));
      case 'number': return typeof value === 'number' && Number.isFinite(value) ? escape(value) : '';
      case 'boolean': return typeof value === 'boolean' && (value || row.boolean_display === 'yes-no')
        ? escape(value ? text(row.true_label) || 'Yes' : text(row.false_label) || 'No') : '';
      case 'url': {
        const href = webUrl(value);
        return href ? `<a href="${escape(href)}">${escape(text(value))}</a>` : '';
      }
      case 'select': case 'multiselect': {
        const option = (v: string) => {
          const label = field.option_labels?.[field.options?.indexOf(v) ?? -1] || v;
          const links = Array.isArray(row.item_links) ? row.item_links.filter(record) : [];
          const href = webUrl(links.find(link => link.value === v)?.url);
          return item(label, href ? `<a href="${escape(href)}">${escape(label)}</a>` : escape(label));
        };
        return field.type === 'select' ? (text(value) ? option(text(value)) : '')
          : Array.isArray(value) ? list([...new Set(value.map(text).filter(Boolean))].map(option), Boolean(text(row.item_html))) : '';
      }
      case 'page_ref': case 'page_ref_list': {
        const ids = field.type === 'page_ref' ? [text(value)].filter(Boolean)
          : Array.isArray(value) ? value.map(text).filter(Boolean) : [];
        if (!ids.length || !options.pageSource) return '';
        const pages = options.pageSource({ ids: [...new Set(ids)], ...(field.ref_content_type ? { content_type: field.ref_content_type } : {}) });
        const links = pages.flatMap(page => {
          const url = webUrl(page.url), title = text(page.title);
          if (!url || !title) return [];
          const href = url.startsWith('/') ? applyTrailingSlash(url, options.context?.pagination?.trailing_slash ?? 'always') : url;
          return [item(title, `<a href="${escape(href)}">${escape(title)}</a>`)];
        });
        return field.type === 'page_ref' ? links[0] ?? '' : list(links, Boolean(text(row.item_html)));
      }
      default: return '';
    }
  }
  const rows = data.fields.flatMap(row => {
    if (!record(row)) return [];
    const name = text(row.field), field = schema.get(name);
    // Check the schema even if an unsanitized editor context supplied a private value.
    if (!field || field.rendered === false || name.startsWith('_') || !Object.hasOwn(values, name)) return [];
    const value = valueHtml(field, values[name], row);
    if (!value) return [];
    const label = text(row.label) || field.label || name;
    // Only these two presentation slots exist. No Page/context expressions or
    // conditional language, and never evaluate tokens inside a field value.
    const template = text(row.html) || '<dt>{{label}}</dt><dd>{{value}}</dd>';
    const content = present(template, label, value);
    const classes = text(row.css_class).split(/\s+/).filter(name => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name));
    const css = text(row.css);
    return [`<div class="${['field-list-row', ...classes].join(' ')}"${css ? ` style="${escape(css)}"` : ''}>${content}</div>`];
  });
  if (!rows.length) return '';
  const title = text(data.title);
  return `${title ? `<h2>${escape(title)}</h2>` : ''}<dl>${rows.join('')}</dl>`;
}
