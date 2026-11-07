// Helpers shared by package export and import.

import { rewriteBlockReferences, type BlockReferenceMaps, type BlockType, type PackageBlockType } from '@typeroll/shared';

const APP_TYPE = /^extension--(.+)--([a-z0-9][a-z0-9_-]*)$/;

/** Properties of a stored block type that belong to the site, not to the definition. */
const SITE_MANAGED = ['created_at', 'updated_at', 'created_by', 'origin', 'imported_from', 'extension', 'shared', 'styles_compiled'];

/**
 * A site block type as a package carries it: the definition only. Export and
 * import both use this shape, so the same definition compares equal on a site
 * that already has it.
 */
export function packageBlockTypeOf(type: BlockType): PackageBlockType {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(type)) if (!SITE_MANAGED.includes(key) && value !== undefined) out[key] = value;
  return JSON.parse(JSON.stringify(out)) as PackageBlockType;
}

/** App blocks a site has: installation segment of the block type id → extension id, and the reverse. */
export function appInstallations(types: readonly BlockType[]): { byInstallation: Record<string, string>; byExtension: Record<string, string> } {
  const byInstallation: Record<string, string> = {}, byExtension: Record<string, string> = {};
  for (const type of types) {
    const match = APP_TYPE.exec(type.id);
    if (!match || !type.extension?.extension_id) continue;
    byInstallation[match[1]] = type.extension.extension_id;
    byExtension[type.extension.extension_id] ??= match[1];
  }
  return { byInstallation, byExtension };
}

export const isAppBlockType = (id: string) => APP_TYPE.test(id);

/** Point a block type definition's own references (composition, alias target, part styles) through the id maps. */
export function rewriteBlockTypeDefinition(type: PackageBlockType, maps: BlockReferenceMaps): PackageBlockType {
  const rename = (id: unknown) => typeof id === 'string' ? maps.blockTypes?.get(id) ?? id : id;
  const next: Record<string, unknown> = { ...type };
  if (Array.isArray(type.composition)) next.composition = rewriteBlockReferences(type.composition, maps);
  if (type.expand_to && typeof type.expand_to === 'object') {
    const defaults = { ...(type.expand_to.defaults ?? {}) } as Record<string, unknown>;
    if ('item_block' in defaults) defaults.item_block = rename(defaults.item_block);
    next.expand_to = { ...type.expand_to, target: rename(type.expand_to.target) as string, defaults };
  }
  return next as PackageBlockType;
}

/** A style's default block parts (`<type>.<part>`) through a block type map. */
export function rewriteStyleParts(parts: readonly string[] | undefined, types: ReadonlyMap<string, string>): string[] | undefined {
  if (!parts) return undefined;
  return parts.map(ref => {
    const dot = ref.lastIndexOf('.');
    if (dot < 1) return ref;
    const type = ref.slice(0, dot);
    return types.has(type) ? `${types.get(type)}${ref.slice(dot)}` : ref;
  });
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
