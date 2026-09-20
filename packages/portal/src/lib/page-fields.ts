import type { ContentType, FieldDefinition, Page } from '@typeroll/shared';
import { DEFAULT_CONTENT_TYPE, contentPagePath, contentTypeAllowsTemplate, pageHeadingError } from '@typeroll/shared';
import { vstore } from './version-store';

export async function pageContentType(ctx: { orgId: string; siteId: string; versionId: string }, page: Pick<Page, 'content_type'>): Promise<ContentType | null> {
  const name = page.content_type ?? 'page';
  return await vstore.contentType(ctx.orgId, ctx.siteId, ctx.versionId, name) ?? (name === 'page' ? DEFAULT_CONTENT_TYPE : null);
}

export function validatePageFields(type: ContentType, incoming: unknown, requireComplete = false): string | null {
  return validateFieldValues(type.fields, incoming, '', requireComplete);
}

function validateFieldValues(definitions: FieldDefinition[], incoming: unknown, prefix = '', requireComplete = false): string | null {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return 'fields must be an object';
  if (requireComplete) for (const field of definitions) {
    const value = Object.hasOwn(incoming, field.name) ? (incoming as Record<string, unknown>)[field.name] : field.default;
    if (field.required && (value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length))) return `${prefix}${field.name} is required`;
  }
  const allowed = new Map(definitions.map(field => [field.name, field]));
  for (const [name, value] of Object.entries(incoming)) {
    const field = allowed.get(name);
    if (!field) return `Unknown field ${prefix}${name}`;
    if (value == null) continue;
    if (['array', 'list', 'list_simple', 'page_ref_list', 'multiselect'].includes(field.type) && !Array.isArray(value)) return `${name} must be an array`;
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${name} must be a number`;
    if (field.type === 'boolean' && typeof value !== 'boolean') return `${name} must be a boolean`;
    if (['text', 'textarea', 'richtext', 'image', 'file', 'color', 'url', 'email', 'date', 'datetime', 'select', 'page_ref', 'content_type_ref'].includes(field.type) && typeof value !== 'string') return `${prefix}${name} must be a string`;
    if (['page_ref_list', 'list_simple', 'multiselect'].includes(field.type) && (value as unknown[]).some(entry => typeof entry !== 'string')) return `${prefix}${name} must contain strings`;
    if (field.type === 'multiselect' && (value as string[]).some(entry => !field.options?.includes(entry))) return `${prefix}${name} contains an unsupported choice`;
    if (field.type === 'multiselect' && new Set(value as string[]).size !== (value as string[]).length) return `${prefix}${name} contains duplicate choices`;
    if (field.type === 'select' && field.options && !field.options.includes(String(value))) return `Invalid value for ${name}`;
    if (field.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return `${prefix}${name} must be an object`;
    if (field.item_key && ['array', 'list'].includes(field.type) && Array.isArray(value)) {
      const keys = value.map(row => row && typeof row === 'object' ? row[field.item_key!] : undefined);
      if (keys.some(key => typeof key !== 'string' || !key || key.length > 200) || new Set(keys).size !== keys.length)
        return `${prefix}${name} requires unique nonempty ${field.item_key} values`;
    }
    if (field.fields && ['object', 'array', 'list'].includes(field.type)) {
      for (const child of field.type === 'object' ? [value] : value as unknown[]) {
        const error = validateFieldValues(field.fields, child, `${prefix}${name}.`, requireComplete);
        if (error) return error;
      }
    }
  }
  return null;
}

export async function pageAddress(ctx: { orgId: string; siteId: string; versionId: string }, page: Page): Promise<string | null> {
  const type = await pageContentType(ctx, page);
  return type ? contentPagePath(page, type) : null;
}

/** Reused at creation, draft writes, commit and structural type changes. */
export async function validatePagePresentation(ctx: { orgId: string; siteId: string; versionId: string }, type: ContentType, input: { breadcrumb_label?: unknown; noindex?: unknown; nofollow?: unknown; template?: unknown; sort_order?: unknown; blocks?: Page['blocks']; content_mode?: string; html_content?: string }): Promise<string | null> {
  if (input.breadcrumb_label != null && (typeof input.breadcrumb_label !== 'string' || input.breadcrumb_label.length > 200)) return 'breadcrumb_label must be text up to 200 characters, or null';
  for (const key of ['noindex', 'nofollow'] as const) if (input[key] != null && typeof input[key] !== 'boolean') return `${key} must be boolean`;
  if (input.sort_order != null && (typeof input.sort_order !== 'number' || !Number.isFinite(input.sort_order))) return 'Page order must be a finite number';
  if (input.template != null && typeof input.template !== 'string') return 'Template must be an ID, or null to use the content type default';
  const id = input.template || type.template;
  if (!id) return pageHeadingError(input);
  const template = await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, String(id));
  if (!template) return 'Template not found in this version';
  if (!contentTypeAllowsTemplate(type, template)) return 'This template is not allowed for the content type. Choose an allowed template or use the content type default.';
  return pageHeadingError(input, template.blocks);
}
