import { gzipSync, gunzipSync } from 'node:zlib';
// Firestore cannot store directly-nested arrays — `[[a], [b]]` is rejected
// with `INVALID_ARGUMENT: Property array contains an invalid nested entity`.
// Our block trees legitimately contain that shape (`Block.slots: Block[][]`),
// and the fixtures backend (plain JSON) accepts it, so the mismatch only
// surfaces in production. This codec makes the Firestore backend shape-
// transparent: on write, any array that appears directly inside another
// array is wrapped in a single-key marker map; on read the marker is
// unwrapped. Lossless for every JSON value, invisible to callers.
//
// The marker key is namespaced so it can't collide with real document
// fields (customer data flows through sanitizers that would never emit it,
// and our own types never use the prefix). NOTE the single underscores:
// Firestore RESERVES field names matching __.*__ ("field name
// '__tr_nested_array__' is reserved"), so a dunder-style marker is itself
// rejected at write time — another fixtures-vs-Firestore gap no local test
// can catch.

const MARKER = '_tr_nested_array_';
const SNAPSHOT_MARKER = '_tr_snapshot_json_';
const BLOCKS_MARKER = '_tr_blocks_gz_';

/**
 * Block trees are stored compressed instead of as native nested maps.
 *
 * Firestore caps how deeply a document may nest, and a real composition
 * reaches it: moveria-se's header and footer sit at exactly the ceiling, which
 * is why an ordinary edit adding one wrapper could not be saved. The ceiling is
 * not ours to raise — Firestore rejects the write itself — so the fix is to
 * stop spending nesting on content that is never queried by field.
 *
 * Nothing reads into a block tree: no query filters or orders by it, no field
 * mask selects part of it, and a working copy already stores a whole tree as
 * one value rather than merging into it. So the tree is content, not
 * structure, and it belongs in storage the same way `revisions` already keeps
 * its snapshot — as an opaque payload.
 *
 * Compressed as well as serialized because block JSON repeats the same keys and
 * defaults on every node: measured 6.7-6.8x on the five largest pages in
 * production, which is what keeps the 1 MiB document limit far away rather than
 * merely further off. Base64 rather than raw bytes so the fixtures backend,
 * which is plain JSON, round-trips it identically to Firestore.
 */
const BLOCK_PATHS: Record<string, string[]> = {
  pages: ['blocks'],
  partials: ['blocks'],
  page_templates: ['blocks'],
  // A draft stores the tree one level down, under its `fields` envelope. That
  // envelope is what pushed an at-the-ceiling document over: it is a real
  // Firestore level, so exempting it from the depth check would only move the
  // rejection from us to Firestore. Compressing the tree removes the cost.
  working_copies: ['fields.blocks'],
};

export class StorageDocumentError extends Error {
  readonly status = 422;
  constructor(readonly code: string, message: string, readonly field?: string) { super(message); }
}

/** History is opaque content, never a queryable second Page tree. Keeping its
 * payload as JSON prevents the revision/provenance envelope from adding depth
 * to a Page that Firestore already accepted. Existing object snapshots still read. */
export function encodeFirestoreDocument(documentPath: string, data: Record<string, any>): Record<string, any> {
  const collection = documentPath.split('/').at(-2);
  const fields = collection === 'revisions' ? ['doc'] : collection === 'answer_history' ? ['before', 'after'] : [];
  let prepared = { ...data };
  for (const field of fields) if (isPlainObject(prepared[field])) {
    try { prepared[field] = { [SNAPSHOT_MARKER]: JSON.stringify(prepared[field]) }; }
    catch { throw new StorageDocumentError('storage_document_invalid', 'The history snapshot contains invalid or circular data. No content was saved.', field); }
  }
  // A revision already carries its whole payload as one snapshot string, so its
  // blocks are inside that string and must not be compressed a second time.
  for (const path of fields.length ? [] : BLOCK_PATHS[collection ?? ''] ?? []) {
    prepared = replaceAtPath(prepared, path.split('.'), (tree) => {
      if (!Array.isArray(tree)) return tree;
      try {
        return { [BLOCKS_MARKER]: gzipSync(Buffer.from(JSON.stringify(tree), 'utf8')).toString('base64') };
      } catch {
        throw new StorageDocumentError('storage_document_invalid', 'The block content contains invalid or circular data. No content was saved.', path);
      }
    });
  }
  const seen = new Set<object>();
  function validate(value: unknown, segments: string[] = []) {
    if (segments.length > 21) throw new StorageDocumentError('storage_document_too_deep', 'This document contains too many nested fields for storage. Reduce nesting or contact support before saving again.', segments.join('.'));
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    if (seen.has(value)) throw new StorageDocumentError('storage_document_invalid', 'The document contains circular data. No content was saved.', segments.join('.'));
    seen.add(value);
    for (const [key, child] of Object.entries(value)) validate(child, [...segments, key]);
    seen.delete(value);
  }
  // Validate before recursive encoding too, so a cycle cannot exhaust the stack.
  validate(prepared);
  const encoded = encodeNestedArrays(prepared);
  validate(encoded);
  return encoded;
}

/**
 * Copy `document`, replacing the value at `segments` with `next(value)`.
 *
 * Copies every object along the path rather than writing through, because the
 * caller still owns the data it passed in — mutating a draft's `fields` here
 * would hand the rest of the request a tree that had become a string.
 */
function replaceAtPath(
  document: Record<string, any>,
  segments: string[],
  next: (value: unknown) => unknown,
): Record<string, any> {
  const [head, ...rest] = segments;
  if (head === undefined || !(head in document)) return document;
  if (rest.length === 0) return { ...document, [head]: next(document[head]) };
  const child = document[head];
  return isPlainObject(child) ? { ...document, [head]: replaceAtPath(child, rest, next) } : document;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  // Leave Firestore sentinel values (Timestamp, FieldValue, Buffer, Date…)
  // alone — only walk JSON-shaped data.
  return proto === Object.prototype || proto === null;
}

/**
 * Encode a value for Firestore: every array that is itself an element of
 * an array becomes `{ [MARKER]: [...] }`. Top-level arrays and arrays
 * under object keys stay arrays.
 */
export function encodeNestedArrays<T>(value: T): T {
  return walkEncode(value, false) as T;
}

function walkEncode(value: unknown, insideArray: boolean): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((el) => walkEncode(el, true));
    return insideArray ? { [MARKER]: mapped } : mapped;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkEncode(v, false);
    return out;
  }
  return value;
}

/** Decode a value read from Firestore: unwrap every marker map back to an array. */
export function decodeNestedArrays<T>(value: T): T {
  return walkDecode(value) as T;
}

function walkDecode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walkDecode);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === SNAPSHOT_MARKER && typeof value[SNAPSHOT_MARKER] === 'string') {
      let decoded: unknown;
      try { decoded = JSON.parse(value[SNAPSHOT_MARKER]); } catch { /* Report corruption without returning the payload. */ }
      if (!isPlainObject(decoded)) throw new StorageDocumentError('storage_snapshot_invalid', 'This history snapshot could not be read. Contact support before restoring it.');
      return decoded;
    }
    if (keys.length === 1 && keys[0] === BLOCKS_MARKER && typeof value[BLOCKS_MARKER] === 'string') {
      let decoded: unknown;
      try { decoded = JSON.parse(gunzipSync(Buffer.from(value[BLOCKS_MARKER] as string, 'base64')).toString('utf8')); }
      catch { throw new StorageDocumentError('storage_blocks_invalid', 'The stored block content could not be read. Contact support before editing this page.'); }
      // Decoded content is ordinary data again, so it still needs unwrapping
      // for any nested-array markers that were encoded before compression.
      return Array.isArray(decoded) ? decoded.map(walkDecode) : decoded;
    }
    if (keys.length === 1 && keys[0] === MARKER && Array.isArray(value[MARKER])) {
      return (value[MARKER] as unknown[]).map(walkDecode);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkDecode(v);
    return out;
  }
  return value;
}
