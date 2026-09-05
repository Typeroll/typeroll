import type { Block, BlockType } from './types.js';

export interface CompositionProposal {
  id?: string;
  name: string;
  fields?: ReadonlyArray<{ name: string; type?: string }>;
  blocks: Block[];
  /** Custom blocks whose behavior is genuinely specific to this business. */
  business_specific_block_types?: string[];
}

export type CompositionReviewStatus = 'ready' | 'waiting_for_native_support';

export interface CompositionWorkaround {
  kind: 'raw_html' | 'custom_css' | 'generic_custom_block';
  block_id: string;
  block_type: string;
  detail: string;
}

export interface CompositionReview {
  id?: string;
  name: string;
  status: CompositionReviewStatus;
  required_block_types: string[];
  missing_block_types: string[];
  business_specific_block_types: string[];
  generic_custom_block_types: string[];
  required_item_fields: string[];
  missing_item_fields: string[];
  required_capabilities: string[];
  requires_hosted_verification: true;
  workarounds: CompositionWorkaround[];
}

const ITEM_BINDING = /^\s*\{\{\s*item\.([\w.-]+)\s*\}\}\s*$/;
const ITEM_REFERENCE = /\bitem\.([\w.-]+)/g;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function walk(blocks: readonly Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.children) walk(block.children, visit);
    for (const slot of block.slots ?? []) walk(slot, visit);
  }
}

function collectItemBindings(value: unknown, fields: Set<string>): void {
  if (typeof value === 'string') {
    const match = value.match(ITEM_BINDING);
    if (match?.[1]) fields.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectItemBindings(entry, fields);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectItemBindings(entry, fields);
    }
  }
}

function configuredItemFields(block: Block): string[] {
  const data = block.data ?? {};
  if (block.type === 'template/item_body') return [String(data.field ?? 'body')];
  if (block.type === 'template/item_image') return [String(data.field ?? 'image')];
  if (block.type === 'core/table_of_contents') return [String(data.source_field ?? 'body')];
  if (block.type === 'template/page_date' && typeof data.field === 'string') return [data.field];
  if (block.type === 'template/item_navigation') {
    return [
      data.previous_url_field,
      data.previous_title_field,
      data.next_url_field,
      data.next_title_field,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (block.type === 'core/post_card') {
    return [
      data.title_field, data.excerpt_field, data.image_field, data.image_alt_field,
      data.date_field, data.author_field, data.href_field, data.download_url_field,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (block.type === 'template/show_if' && typeof data.condition === 'string') {
    return [...data.condition.matchAll(ITEM_REFERENCE)].map((match) => match[1]!);
  }
  return [];
}

export function reviewBlockComposition(
  proposal: CompositionProposal,
  registry: ReadonlyMap<string, BlockType> | Record<string, BlockType>,
): CompositionReview {
  const getType = (id: string): BlockType | undefined => (
    registry instanceof Map
      ? registry.get(id)
      : (registry as Record<string, BlockType>)[id]
  );
  const requiredTypes = new Set<string>();
  const requiredFields = new Set<string>();
  const missingTypes = new Set<string>();
  const businessSpecific = new Set(proposal.business_specific_block_types ?? []);
  const usedBusinessSpecific = new Set<string>();
  const genericCustom = new Set<string>();
  const workarounds: CompositionWorkaround[] = [];
  const requiredCapabilities = new Set<string>();

  walk(proposal.blocks, (block) => {
    requiredTypes.add(block.type);
    collectItemBindings(block.data, requiredFields);
    if (JSON.stringify(block.data).includes('{{item.')) {
      requiredCapabilities.add('supports_typed_context_bindings');
    }
    for (const field of configuredItemFields(block)) requiredFields.add(field);
    if (['template/item_body', 'template/item_image', 'template/page_date'].includes(block.type)) {
      requiredCapabilities.add('supports_selected_collection_item_fields');
    }
    if (block.type === 'template/page_breadcrumbs') {
      requiredCapabilities.add('supports_server_rendered_breadcrumbs');
    }
    if (block.type === 'core/table_of_contents') {
      requiredCapabilities.add('supports_server_rendered_table_of_contents');
    }
    if (block.type === 'template/item_navigation') {
      requiredCapabilities.add('supports_explicit_collection_item_navigation');
    }

    const blockType = getType(block.type);
    if (!blockType) {
      missingTypes.add(block.type);
    } else if (blockType.origin !== 'core') {
      if (businessSpecific.has(block.type)) {
        usedBusinessSpecific.add(block.type);
      } else {
        genericCustom.add(block.type);
        workarounds.push({
          kind: 'generic_custom_block',
          block_id: block.id,
          block_type: block.type,
          detail: 'Custom block appears to replace reusable CMS behavior; add native support before migration build.',
        });
      }
    }
    if (block.type === 'core/navigation') {
      requiredCapabilities.add('supports_native_navigation');
    }
    if (block.type === 'core/post_card') {
      requiredCapabilities.add('supports_post_card_field_mapping');
      requiredCapabilities.add('supports_post_card_empty_media_omission');
    }
    if (block.type === 'core/form') {
      requiredCapabilities.add('supports_transitive_form_assets');
    }
    if ((blockType?.schema ?? []).some((field) => field.responsive && block.data?.[field.name]
      && typeof block.data[field.name] === 'object' && !Array.isArray(block.data[field.name]))) {
      requiredCapabilities.add('supports_responsive_data_fields');
    }

    if (block.type === 'core/html') {
      workarounds.push({
        kind: 'raw_html',
        block_id: block.id,
        block_type: block.type,
        detail: 'Raw HTML hides structure from native editing and should not be the migration fallback.',
      });
    }
    if (typeof block.style_overrides?.custom_css === 'string' && block.style_overrides.custom_css.trim()) {
      requiredCapabilities.add('supports_block_instance_custom_css');
      workarounds.push({
        kind: 'custom_css',
        block_id: block.id,
        block_type: block.type,
        detail: 'Per-instance CSS indicates missing native styling or layout controls.',
      });
    }
  });

  const declaredFields = proposal.fields
    ? new Set(proposal.fields.map((field) => field.name))
    : null;
  const missingFields = declaredFields
    ? [...requiredFields].filter((field) => !declaredFields.has(field))
    : [];
  const waiting = missingTypes.size > 0 || missingFields.length > 0 || workarounds.length > 0;

  return {
    ...(proposal.id ? { id: proposal.id } : {}),
    name: proposal.name,
    status: waiting ? 'waiting_for_native_support' : 'ready',
    required_block_types: sorted(requiredTypes),
    missing_block_types: sorted(missingTypes),
    business_specific_block_types: sorted(usedBusinessSpecific),
    generic_custom_block_types: sorted(genericCustom),
    required_item_fields: sorted(requiredFields),
    missing_item_fields: sorted(missingFields),
    required_capabilities: sorted(requiredCapabilities),
    requires_hosted_verification: true,
    workarounds,
  };
}
