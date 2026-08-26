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
    if (keys.length === 1 && keys[0] === MARKER && Array.isArray(value[MARKER])) {
      return (value[MARKER] as unknown[]).map(walkDecode);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkDecode(v);
    return out;
  }
  return value;
}
