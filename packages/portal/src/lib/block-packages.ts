// .tcblocks package format — pack and unpack block-type bundles.
//
// A .tcblocks file is a zip with:
//   manifest.json          { name, version, blocks: [<block_dir>, …] }
//   <block_dir>/block.json (the BlockType minus id, which the import generates)
//   <block_dir>/template.html
//   <block_dir>/styles.css         (optional)
//   <block_dir>/script.js          (optional)
//
// The format is intentionally human-readable: a user can unzip a package
// and edit the files by hand. JSON Schema validation happens on the
// manifest and on each block.json; everything else is treated as opaque
// text and read into the corresponding BlockType field.
//
// Security: this module enforces hard size + entry-count caps before any
// content is parsed. Zip-bomb resistance: each entry's uncompressed size
// is checked against the cap before decompression completes. Entry names
// are validated to reject absolute paths, `..` segments, and anything
// outside the expected `<block_dir>/file` layout. No filesystem writes
// happen during import — block types are written through the datastore.

import JSZip from 'jszip';
import type { BlockType, FieldDefinition } from '@typeroll/shared';

const MAX_ZIP_SIZE = 50 * 1024 * 1024;   // 50 MB input zip
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024; // 200 MB after decompress
const MAX_ENTRIES = 5_000;
const MAX_BLOCKS_PER_PACKAGE = 200;
const MAX_FILE_SIZE = 2 * 1024 * 1024;   // 2 MB per single asset

export interface PackageManifest {
  name: string;
  version: string;
  blocks: string[];
  description?: string;
  author?: string;
}

export interface ImportedBlock {
  /** Stable id we assign at import time. Derived from `package_name/block.name`
   *  so re-importing the same package overwrites rather than duplicates. */
  id: string;
  block_type: BlockType;
}

export interface ImportResult {
  manifest: PackageManifest;
  blocks: ImportedBlock[];
  warnings: string[];
}

export class BlockPackageError extends Error {
  constructor(message: string, public readonly code: 'invalid' | 'too_large' | 'unsafe') {
    super(message);
    this.name = 'BlockPackageError';
  }
}

// ─── Pack ────────────────────────────────────────────────────────────────

/**
 * Serialize a set of BlockTypes into a .tcblocks zip Buffer. The caller
 * decides the package name + version. Block ids in the zip are derived
 * from BlockType.name so a re-import doesn't duplicate.
 */
export async function packBlockTypes(args: {
  manifest: Pick<PackageManifest, 'name' | 'version' | 'description' | 'author'>;
  block_types: BlockType[];
}): Promise<Buffer> {
  const zip = new JSZip();
  const slugs = new Set<string>();
  const blockDirs: string[] = [];

  for (const bt of args.block_types) {
    const dir = slugify(bt.name || bt.id);
    if (slugs.has(dir)) {
      throw new BlockPackageError(
        `Duplicate block dir name "${dir}" — every BlockType.name must be unique within a package.`,
        'invalid',
      );
    }
    slugs.add(dir);
    blockDirs.push(dir);

    // Strip platform-managed fields from block.json. `id`, `created_at`,
    // `imported_from` are regenerated at import. Template/styles/script
    // move to their own files so the .tcblocks zip is easy to diff.
    const meta: Partial<BlockType> = {
      name: bt.name,
      label: bt.label,
      icon: bt.icon,
      category: bt.category,
      container: bt.container,
      slot_count: bt.slot_count,
      slot_labels: bt.slot_labels,
      schema: bt.schema,
      origin: 'third_party',
    };
    // Strip undefined keys for cleaner diffs.
    for (const k of Object.keys(meta) as (keyof typeof meta)[]) {
      if (meta[k] === undefined) delete meta[k];
    }
    zip.file(`${dir}/block.json`, JSON.stringify(meta, null, 2));
    if (bt.template) zip.file(`${dir}/template.html`, bt.template);
    if (bt.styles) zip.file(`${dir}/styles.css`, bt.styles);
    if (bt.script) zip.file(`${dir}/script.js`, bt.script);
  }

  const manifest: PackageManifest = {
    name: args.manifest.name,
    version: args.manifest.version,
    blocks: blockDirs,
    ...(args.manifest.description ? { description: args.manifest.description } : {}),
    ...(args.manifest.author ? { author: args.manifest.author } : {}),
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ─── Unpack ──────────────────────────────────────────────────────────────

/**
 * Validate and unpack a .tcblocks zip. Returns the parsed manifest +
 * ready-to-write BlockType docs. Caller persists them via the datastore.
 *
 * Throws BlockPackageError on any validation failure. Never throws on
 * harmless format issues (missing optional files) — those go in warnings.
 */
export async function unpackBlockPackage(
  data: Buffer | Uint8Array,
  context: { package_name_hint?: string } = {},
): Promise<ImportResult> {
  if (data.byteLength > MAX_ZIP_SIZE) {
    throw new BlockPackageError(
      `Zip exceeds ${MAX_ZIP_SIZE} bytes (got ${data.byteLength}).`,
      'too_large',
    );
  }

  const zip = await JSZip.loadAsync(data).catch((e: unknown) => {
    throw new BlockPackageError(`Could not read zip: ${(e as Error).message}`, 'invalid');
  });

  // Reject directory traversal + absolute paths + excessive entry count.
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) {
    throw new BlockPackageError(
      `Zip has ${entries.length} entries; the cap is ${MAX_ENTRIES}.`,
      'too_large',
    );
  }
  for (const entry of entries) {
    assertSafePath(entry.name);
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new BlockPackageError('Missing manifest.json at zip root.', 'invalid');
  }
  const manifestText = await readEntry(manifestFile);
  const manifest = parseManifest(manifestText);
  if (manifest.blocks.length > MAX_BLOCKS_PER_PACKAGE) {
    throw new BlockPackageError(
      `Package declares ${manifest.blocks.length} blocks; the cap is ${MAX_BLOCKS_PER_PACKAGE}.`,
      'too_large',
    );
  }

  const warnings: string[] = [];
  const importedBlocks: ImportedBlock[] = [];
  const importedAt = new Date().toISOString();
  let totalBytes = 0;

  const packageName = context.package_name_hint ?? manifest.name;

  for (const dir of manifest.blocks) {
    if (!isSafeDirName(dir)) {
      throw new BlockPackageError(`Unsafe block dir name "${dir}".`, 'unsafe');
    }
    const metaFile = zip.file(`${dir}/block.json`);
    if (!metaFile) {
      warnings.push(`Block "${dir}" listed in manifest but has no block.json — skipped.`);
      continue;
    }

    const metaText = await readEntry(metaFile);
    totalBytes += metaText.length;
    const meta = parseBlockMeta(metaText, dir);

    const templateFile = zip.file(`${dir}/template.html`);
    const stylesFile = zip.file(`${dir}/styles.css`);
    const scriptFile = zip.file(`${dir}/script.js`);

    const template = templateFile ? await readEntry(templateFile) : '';
    const styles = stylesFile ? await readEntry(stylesFile) : '';
    const script = scriptFile ? await readEntry(scriptFile) : '';

    for (const len of [template.length, styles.length, script.length]) {
      if (len > MAX_FILE_SIZE) {
        throw new BlockPackageError(
          `Asset in block "${dir}" exceeds ${MAX_FILE_SIZE} bytes.`,
          'too_large',
        );
      }
      totalBytes += len;
    }
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
      throw new BlockPackageError(
        `Total uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED} bytes (zip bomb guard).`,
        'too_large',
      );
    }

    // Flat id — datastore lists docs directly in a dir; a slash would
    // route the write into a subcollection invisible to listDocs.
    // Re-importing the same package overwrites the same id; package
    // provenance is preserved in `imported_from`.
    const blockId = slugify(meta.name);
    const blockType: BlockType = {
      id: blockId,
      name: meta.name,
      label: meta.label,
      icon: meta.icon,
      category: meta.category,
      container: meta.container,
      slot_count: meta.slot_count,
      slot_labels: meta.slot_labels,
      schema: meta.schema,
      template: template || undefined,
      styles: styles || undefined,
      script: script || undefined,
      origin: 'third_party',
      imported_from: {
        package_name: packageName,
        version: manifest.version,
        imported_at: importedAt,
      },
      created_at: importedAt,
    };
    importedBlocks.push({ id: blockId, block_type: blockType });
  }

  return { manifest, blocks: importedBlocks, warnings };
}

// ─── Validation primitives ───────────────────────────────────────────────

function assertSafePath(name: string): void {
  // JSZip preserves zip entries' paths verbatim. Reject anything that
  // could escape the implied root.
  if (name.startsWith('/')) throw new BlockPackageError(`Absolute path entry "${name}".`, 'unsafe');
  if (name.includes('..')) throw new BlockPackageError(`Path traversal in entry "${name}".`, 'unsafe');
  if (name.includes('\\')) throw new BlockPackageError(`Backslash in entry "${name}".`, 'unsafe');
  if (/[\x00-\x1f]/.test(name)) throw new BlockPackageError(`Control chars in entry "${name}".`, 'unsafe');
}

function isSafeDirName(dir: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dir);
}

async function readEntry(file: JSZip.JSZipObject): Promise<string> {
  return file.async('string');
}

function parseManifest(text: string): PackageManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BlockPackageError(`manifest.json is not valid JSON: ${(e as Error).message}`, 'invalid');
  }
  if (!json || typeof json !== 'object') {
    throw new BlockPackageError('manifest.json must be an object.', 'invalid');
  }
  const m = json as Partial<PackageManifest>;
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.name)) {
    throw new BlockPackageError(
      'manifest.name must be a lowercase kebab-/underscore-case string (1-64 chars).',
      'invalid',
    );
  }
  if (typeof m.version !== 'string' || !/^[\w.+-]{1,32}$/.test(m.version)) {
    throw new BlockPackageError('manifest.version must be a 1-32 char version string.', 'invalid');
  }
  if (!Array.isArray(m.blocks) || m.blocks.some((b) => typeof b !== 'string')) {
    throw new BlockPackageError('manifest.blocks must be an array of strings.', 'invalid');
  }
  return {
    name: m.name,
    version: m.version,
    blocks: m.blocks,
    description: typeof m.description === 'string' ? m.description : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
  };
}

function parseBlockMeta(text: string, dir: string): {
  name: string;
  label: string;
  icon?: string;
  category: BlockType['category'];
  container: BlockType['container'];
  slot_count?: number;
  slot_labels?: string[];
  schema: FieldDefinition[];
} {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BlockPackageError(
      `block.json in "${dir}" is not valid JSON: ${(e as Error).message}`,
      'invalid',
    );
  }
  if (!json || typeof json !== 'object') {
    throw new BlockPackageError(`block.json in "${dir}" must be an object.`, 'invalid');
  }
  const m = json as Record<string, unknown>;
  const name = typeof m.name === 'string' ? m.name : dir;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new BlockPackageError(
      `block.json "name" in "${dir}" must be lowercase kebab/underscore (1-64 chars).`,
      'invalid',
    );
  }
  const label = typeof m.label === 'string' && m.label.length > 0 ? m.label : name;
  const category = m.category as BlockType['category'];
  if (!['layout', 'content', 'media', 'custom'].includes(category)) {
    throw new BlockPackageError(
      `block.json "category" in "${dir}" must be one of layout|content|media|custom.`,
      'invalid',
    );
  }
  const container = m.container;
  if (container !== true && container !== false && container !== 'slots') {
    throw new BlockPackageError(
      `block.json "container" in "${dir}" must be true | false | "slots".`,
      'invalid',
    );
  }
  if (container === 'slots') {
    if (typeof m.slot_count !== 'number' || m.slot_count < 1 || m.slot_count > 8) {
      throw new BlockPackageError(
        `block.json "slot_count" in "${dir}" must be 1-8 when container="slots".`,
        'invalid',
      );
    }
  }
  if (!Array.isArray(m.schema)) {
    throw new BlockPackageError(`block.json "schema" in "${dir}" must be an array.`, 'invalid');
  }
  return {
    name,
    label,
    icon: typeof m.icon === 'string' ? m.icon : undefined,
    category,
    container: container as BlockType['container'],
    slot_count: typeof m.slot_count === 'number' ? m.slot_count : undefined,
    slot_labels: Array.isArray(m.slot_labels)
      ? (m.slot_labels.filter((l) => typeof l === 'string') as string[])
      : undefined,
    schema: m.schema as FieldDefinition[],
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}
