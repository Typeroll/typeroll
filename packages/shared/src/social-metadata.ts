import type { ContentType, Page, SiteSettings } from './types.js';
import { ogLocale } from './defaults.js';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
/** Resolve sharing metadata from public content only, without storing derived mirrors. */
export function socialMetadata(page: Page, settings: SiteSettings, type?: ContentType, pageUrl?: string) {
  const field = type?.fields.find(field => field.rendered !== false && type.schema_field_map?.[field.name] === 'image' && text(page.fields?.[field.name]));
  const mappedImage = field ? text(page.fields?.[field.name]) : '';
  const altField = field && type?.fields.find(candidate => candidate.name === `${field.name}_alt` && candidate.rendered !== false);
  const mappedAlt = altField ? text(page.fields?.[altField.name]) : '';
  const baseTitle = text(page.seo_title) || page.title;
  const suffix = settings.default_seo_suffix || '';
  const documentTitle = page.append_seo_suffix === false || !suffix || baseTitle.endsWith(suffix) ? baseTitle : baseTitle + suffix;
  const explicitImage = text(page.og_image);
  const selectedImage = explicitImage || mappedImage || settings.default_og_image || settings.logo || '';
  let image = selectedImage;
  if (selectedImage && pageUrl) {
    try { const url = new URL(selectedImage, pageUrl); image = /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch { image = ''; }
  }
  const bodyAlt = page.html_content?.match(/<img\b[^>]*\balt=["']([^"']*)["']/i)?.[1] || '';
  return {
    type: page.kind === 'article' || ['Article', 'BlogPosting', 'NewsArticle'].includes(page.schema_type || type?.schema_type || '') ? 'article' : 'website',
    title: text(page.og_title) || documentTitle,
    description: text(page.og_description) || text(page.seo_description) || settings.default_meta_description || settings.tagline || '',
    image,
    imageAlt: text(page.seo_image_alt) || (!explicitImage && mappedImage ? mappedAlt : bodyAlt),
    locale: ogLocale(page.language || settings.language),
  };
}
