import type { BlockType, FieldDefinition } from './types.js';
import { typographyFields } from './presentation-fields.js';

const cellFields: FieldDefinition[] = [
  { name: 'html', type: 'richtext', label: 'Content' },
  { name: 'header', type: 'boolean', label: 'Header cell' },
  { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center', 'right'], default: 'left' },
  { name: 'background', type: 'color', label: 'Background' },
  { name: 'color', type: 'color', label: 'Text color' },
  { name: 'colspan', type: 'number', label: 'Columns spanned', min: 1, max: 100, default: 1 },
  { name: 'rowspan', type: 'number', label: 'Rows spanned', min: 1, max: 100, default: 1 },
  { name: 'width', type: 'text', label: 'Width', placeholder: '25% or 12rem' },
];

export const ARTICLE_BLOCK_TYPES: BlockType[] = [
  {
    id: 'core/rich_heading', name: 'rich_heading', label: 'Formatted heading', icon: 'heading', category: 'content', container: false,
    schema: [
      { name: 'html', type: 'richtext', label: 'Heading', required: true },
      { name: 'level', type: 'select', label: 'Level', options: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], default: 'h2' },
      { name: 'anchor_id', type: 'text', label: 'Anchor ID' },
      { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center', 'right'], default: 'left', responsive: true },
      ...typographyFields,
      { name: 'font_weight', type: 'select', label: 'Weight', options: ['400', '500', '600', '700', '800'], default: '600', responsive: true },
      { name: 'font', type: 'select', label: 'Font', options: ['heading', 'body', 'inherit'], default: 'heading' },
      { name: 'color', type: 'color', label: 'Text color' },
    ],
    template: '<{{=level}} data-block="rich_heading" data-level="{{level}}" data-font="{{font}}" {{{heading_anchor_attr}}} style="--align:{{align}};--font_weight:{{font_weight}};--heading-color:{{color}}">{{{html}}}</{{=level}}>',
    styles: `[data-block="rich_heading"][data-level] { margin:0;text-align:var(--align,left);font-size:var(--font_size_px,var(--rich-heading-size,var(--type-h2,1.375rem)));line-height:var(--line_height,1.25);font-weight:var(--font_weight,600);color:var(--heading-color,inherit);overflow-wrap:anywhere; }
[data-block="rich_heading"][data-font="heading"] { font-family:var(--font-heading,inherit); }
[data-block="rich_heading"][data-font="body"] { font-family:var(--font-body,inherit); }
[data-block="rich_heading"][data-font="inherit"] { font-family:inherit; }
${['h1','h2','h3','h4','h5','h6'].map(level => `[data-block="rich_heading"][data-level="${level}"] { --rich-heading-size:var(--${level}_size_px,var(--type-${level},1.25rem)); }`).join('\n')}
[data-block="rich_heading"] a { color:inherit;text-decoration:underline;text-underline-offset:.15em; }
[data-block="rich_heading"] a:focus-visible { outline:2px solid currentColor;outline-offset:3px; }`,
    origin: 'core', created_at: '1970-01-01T00:00:00Z',
  },
  {
    id: 'core/table', name: 'table', label: 'Table', icon: 'table', category: 'content', container: false,
    schema: [
      { name: 'caption', type: 'richtext', label: 'Caption' },
      { name: 'rows', type: 'array', label: 'Rows', fields: [
        { name: 'cells', type: 'array', label: 'Cells', fields: cellFields },
      ] },
      { name: 'density', type: 'select', label: 'Cell spacing', options: ['compact', 'normal', 'relaxed'], default: 'normal' },
      { name: 'borders', type: 'select', label: 'Borders', options: ['all', 'rows', 'none'], default: 'all' },
      { name: 'striped', type: 'boolean', label: 'Alternating row background', default: false },
      { name: 'source', type: 'richtext', label: 'Source / credit' },
    ],
    template: `<figure data-block="table" data-density="{{density}}" data-borders="{{borders}}" data-striped="{{striped}}"><div class="block-table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table>{{{table_caption_html}}}<tbody>{{{table_rows_html}}}</tbody></table></div><figcaption>{{{source}}}</figcaption></figure>`,
    styles: `[data-block="table"]{margin:1rem 0;min-width:0;max-width:100%}[data-block="table"] .block-table-scroll{overflow-x:auto;max-width:100%}[data-block="table"] table{border-collapse:collapse;width:100%;font:inherit}[data-block="table"] td,[data-block="table"] th{padding:.65rem;border:1px solid var(--color-border,#ddd);vertical-align:top}[data-block="table"] p{margin:0}[data-block="table"] caption{text-align:left;margin-bottom:.5rem}[data-block="table"][data-density="compact"] td,[data-block="table"][data-density="compact"] th{padding:.3rem}[data-block="table"][data-density="relaxed"] td,[data-block="table"][data-density="relaxed"] th{padding:1rem}[data-block="table"][data-borders="rows"] td,[data-block="table"][data-borders="rows"] th{border-width:0 0 1px}[data-block="table"][data-borders="none"] td,[data-block="table"][data-borders="none"] th{border:0}[data-block="table"][data-striped="true"] tr:nth-child(even){background:var(--color-bg-subtle,#f6f6f6)}[data-block="table"] figcaption:empty{display:none}`,
    origin: 'core', created_at: '1970-01-01T00:00:00Z',
  },
  {
    id: 'core/list', name: 'list', label: 'List', icon: 'list', category: 'content', container: false,
    schema: [
      { name: 'marker', type: 'select', label: 'List marker', options: ['auto', 'none', 'check'], option_labels: ['Bullet or number', 'Custom / no marker', 'Checkmark'], default: 'auto' },
      { name: 'ordered', type: 'boolean', label: 'Numbered list', default: false },
      { name: 'start', type: 'number', label: 'Start number', default: 1 },
      { name: 'items', type: 'array', label: 'Items', fields: [{ name: 'html', type: 'richtext', label: 'Content' }] },
    ],
    template: `<div data-block="list" data-marker="{{marker}}">{{{list_html}}}</div>`,
    styles: `[data-block="list"] ul,[data-block="list"] ol{padding-inline-start:1.5rem;margin:1rem 0}[data-block="list"] li{margin:.35rem 0}[data-block="list"] li>p{margin:0}[data-block="list"][data-marker="none"] ul,[data-block="list"][data-marker="none"] ol,[data-block="list"][data-marker="check"] ul,[data-block="list"][data-marker="check"] ol{list-style:none;padding-inline-start:0}[data-block="list"][data-marker="check"] li{position:relative;padding-inline-start:1.5em}[data-block="list"][data-marker="check"] li::before{content:"✓";position:absolute;inset-inline-start:0}[data-block="list"] li:has(input[type="checkbox"]){list-style:none}[data-block="list"][data-marker="check"] li:has(input[type="checkbox"])::before{content:none}`,
    origin: 'core', created_at: '1970-01-01T00:00:00Z',
  },
];

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const color = (value: unknown): string => /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(text(value)) ? text(value) : '';
const dimension = (value: unknown): string => /^\d+(\.\d+)?(px|rem|em|%)$/.test(text(value)) ? text(value) : '';
const span = (value: unknown): number => Math.max(1, Math.min(100, Math.trunc(Number(value)) || 1));

/** Raw rich text follows the same final customer-HTML sanitizer as prose. */
export function prepareArticleBlockData(type: string, data: Record<string, unknown>): void {
  if (type === 'core/container') {
    data.container_kind = data.layout === 'flow' ? 'semantic-container' : 'container';
    data.tag ||= 'div';
    const escape = (value: unknown) => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
    data.container_attributes_html = records(data.attributes).filter(attribute => /^(?:data-[a-z0-9_-]+|aria-[a-z0-9_-]+|role|itemscope|itemtype|itemprop|lang|dir|hidden|title)$/.test(text(attribute.name)))
      .map(attribute => `${text(attribute.name)}="${escape(attribute.value)}"`).join(' ');
  }
  if (type === 'core/table') {
    data.table_caption_html = data.caption ? `<caption>${text(data.caption)}</caption>` : '';
    data.table_rows_html = records(data.rows).map(row => `<tr>${records(row.cells).map(cell => {
      const tag = cell.header === true ? 'th' : 'td';
      const align = ['left', 'center', 'right'].includes(text(cell.align)) ? cell.align : 'left';
      const style = `text-align:${align};${color(cell.background) ? `background:${color(cell.background)};` : ''}${color(cell.color) ? `color:${color(cell.color)};` : ''}${dimension(cell.width) ? `width:${dimension(cell.width)};` : ''}`;
      return `<${tag} colspan="${span(cell.colspan)}" rowspan="${span(cell.rowspan)}" style="${style}">${text(cell.html)}</${tag}>`;
    }).join('')}</tr>`).join('');
  }
  if (type === 'core/list') {
    const tag = data.ordered === true ? 'ol' : 'ul';
    const start = Number.isSafeInteger(Number(data.start)) ? Number(data.start) : 1;
    data.list_html = `<${tag}${tag === 'ol' ? ` start="${start}"` : ''}>${records(data.items).map(item => `<li>${text(item.html)}</li>`).join('')}</${tag}>`;
  }
}
