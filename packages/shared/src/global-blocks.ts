import type { Partial as PartialDoc } from './types.js';

/**
 * Replace `<x-include name="…" />` (and the long form
 * `<x-include name="…"></x-include>`) inside a page body with the published
 * HTML of the matching free global block.
 *
 * The substitution is intentionally inert about anything else — only published
 * blocks are inlined, and missing references render as an empty string.
 *
 * Safety model: partial bodies are sanitized at save time by the partial PUT
 * route + the AI chat's update_partial tool, so the inlined HTML is already
 * safe. The renderer additionally re-wraps the merged result in sanitizeBody
 * so even if a write path slipped a raw body through, the output stays safe.
 *
 * Done as a string pass before sanitization so the sanitizer never has to know
 * the `<x-include>` tag exists (it would strip an unknown element otherwise).
 */
export function expandIncludes(html: string, partials: PartialDoc[]): string {
  if (!html || !html.includes('<x-include')) return html;
  const byId = new Map<string, PartialDoc>();
  for (const p of partials) {
    if (p.kind === 'free' && p.status === 'published') byId.set(p.id, p);
  }
  // Matches both self-closing and explicit-close forms. The name attribute is
  // required; missing-id includes simply collapse to an empty string.
  const tag = /<x-include\s+name=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/x-include>)/gi;
  return html.replace(tag, (_match, dq, sq) => {
    const id = String(dq ?? sq ?? '').trim();
    if (!id) return '';
    const doc = byId.get(id);
    return doc?.html_content ?? '';
  });
}

/**
 * Replace an HTML-mode `<x-form id="…" />` authoring directive with the same
 * complete server-rendered form shell used by a `core/form` block.
 *
 * The directive never reaches the browser: preview and static generation call
 * this before their final sanitization pass. That keeps tokens, initial step
 * state, and field markup on the trusted render path instead of introducing a
 * second client-side shortcode runtime.
 */
export function expandFormIncludes(
  html: string,
  formSource: (formId: string) => string | undefined,
): string {
  if (!html || !html.includes('<x-form')) return html;
  const tag = /<x-form\s+id=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/x-form>)/gi;
  return html.replace(tag, (_match, dq, sq) => {
    const id = String(dq ?? sq ?? '').trim();
    if (!id) return '';
    const rendered = formSource(id);
    if (rendered !== undefined) return rendered;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return `<!-- x-form: unknown form_id ${safeId || 'invalid'} -->`;
  });
}

export interface ExtensionIncludeDescriptor {
  extension_id: string;
  installation_id: string;
  component_id: string;
  label?: string;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Expand an HTML-mode `<x-extension block="…" props='{"key":"value"}' />`
 * authoring reference to the same inert mount shell produced by renderBlocks.
 * URL context is intentionally absent: the browser host captures declared
 * inputs after page load and keeps sensitive values out of generated HTML.
 */
export function expandExtensionIncludes(
  html: string,
  extensionSource: (blockTypeId: string) => ExtensionIncludeDescriptor | undefined,
): string {
  if (!html || !html.includes('<x-extension')) return html;
  const tag = /<x-extension\b([^>]*?)(?:\/\s*>|>\s*<\/x-extension>)/gi;
  return html.replace(tag, (_match, rawAttributes: string) => {
    const attributes = new Map<string, string>();
    const attr = /([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match: RegExpExecArray | null;
    while ((match = attr.exec(rawAttributes)) !== null) {
      attributes.set(match[1]!.toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? ''));
    }
    const blockTypeId = (attributes.get('block') ?? '').trim();
    const descriptor = blockTypeId ? extensionSource(blockTypeId) : undefined;
    if (!descriptor) {
      const safeId = blockTypeId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 128);
      return `<!-- x-extension: unknown block ${safeId || 'invalid'} -->`;
    }
    let props: Record<string, unknown> = {};
    const rawProps = attributes.get('props');
    if (rawProps) {
      if (rawProps.length > 65_536) return '<!-- x-extension: props too large -->';
      try {
        const parsed = JSON.parse(rawProps) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        props = parsed as Record<string, unknown>;
      } catch {
        return '<!-- x-extension: invalid props -->';
      }
    }
    const label = descriptor.label?.trim() || 'Extension';
    return `<div class="tr-extension-mount" data-tr-extension="${escapeAttribute(descriptor.extension_id)}" data-tr-extension-installation="${escapeAttribute(descriptor.installation_id)}" data-tr-extension-component="${escapeAttribute(descriptor.component_id)}" data-block-data="${escapeAttribute(JSON.stringify(props))}"><p class="tr-extension-placeholder">${escapeAttribute(label)} loads on the published site.</p></div>`;
  });
}
