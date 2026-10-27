import { Parser } from 'htmlparser2';
import type { Block, BlockType, ContentType, FieldDefinition, Page, Partial as PartialDoc } from '@typeroll/shared';
import { pageContentValues, publicContentPage } from '@typeroll/shared';

/** Page-owned image references, not every image in the site's media library. */
export function pageSitemapImages(page: Page, options: {
  pageUrl: string;
  contentType: ContentType;
  registry: Map<string, BlockType>;
  template?: Block[];
  partials?: PartialDoc[];
}): string[] {
  const images = new Set<string>();
  const publicPage = publicContentPage(page, options.contentType);
  const values = pageContentValues(publicPage);
  const bind = (value: unknown): unknown => typeof value === 'string'
    ? value.replace(/{{\s*page\.([\w.]+)\s*}}/g, (_, path: string) => {
      const keys = path.split('.');
      let result: unknown = values;
      for (const key of keys) result = result && typeof result === 'object' && Object.hasOwn(result, key)
        ? (result as Record<string, unknown>)[key] : undefined;
      return typeof result === 'string' ? result : '';
    }) : value;
  const add = (raw: unknown) => {
    const value = bind(raw);
    if (typeof value !== 'string' || !value.trim() || /{{|}}/.test(value)) return;
    try {
      const url = new URL(value, options.pageUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      url.hash = '';
      images.add(url.href);
    } catch { /* An invalid or unresolved reference is not an image URL. */ }
  };
  const html = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    new Parser({ onopentag(name, attrs) {
      if (name === 'img') add(attrs.src);
      if (name === 'img' || name === 'source') {
        // Remove inline data candidates before splitting: their payload can contain commas.
        const srcset = (attrs.srcset ?? '').replace(/data:[^\s]+(?:\s+[\d.]+[wx])?/g, '');
        for (const candidate of srcset.split(',')) add(candidate.trim().split(/\s+/)[0]);
      }
    } }, { decodeEntities: true }).end(String(bind(raw)));
  };
  const fields = (schema: FieldDefinition[], data: Record<string, unknown>) => {
    for (const field of schema) {
      if (field.rendered === false) continue;
      const value = data[field.name];
      if (field.type === 'image') {
        if (value && typeof value === 'object' && !Array.isArray(value)) add((value as Record<string, unknown>).src);
        else add(value);
      } else if (field.type === 'richtext') html(value);
      else if (field.fields) {
        for (const row of Array.isArray(value) ? value : [value]) {
          if (row && typeof row === 'object') fields(field.fields, row as Record<string, unknown>);
        }
      }
    }
  };
  const visited = new Set<string>();
  const blocks = (tree: Block[]) => {
    for (const block of tree) {
      const schema = options.registry.get(block.type)?.schema ?? [];
      fields(schema, block.data);
      if (block.type === 'core/html') html(block.data.html);
      for (const override of Object.values(block.responsive ?? {})) fields(schema, override?.data_overrides ?? {});
      if (block.type === 'core/global_block') {
        const id = String(block.data.global_block_id ?? '');
        if (!visited.has(id)) {
          visited.add(id);
          const partial = options.partials?.find(item => item.id === id || item.name === id);
          if (partial?.status === 'published') {
            if (partial.content_mode === 'html') html(partial.html_content);
            else blocks(partial.blocks ?? []);
          }
        }
      }
      blocks(block.children ?? []);
      for (const slot of block.slots ?? []) blocks(slot);
    }
  };
  add(publicPage.og_image);
  fields(options.contentType.fields, values);
  if (publicPage.content_mode === 'html') html(publicPage.html_content);
  else blocks(publicPage.blocks ?? []);
  blocks(options.template ?? []);
  // Google accepts at most 1,000 image entries per Page.
  return [...images].slice(0, 1000);
}

export function imageSitemapEntry(loc: string, images: string[]): string {
  if (!images.length) return '';
  return `<url><loc>${escapeXml(loc)}</loc>${images.map(image => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`).join('')}</url>`;
}
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
