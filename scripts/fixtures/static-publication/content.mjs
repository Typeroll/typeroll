/**
 * Sorted keys and indentation keep the published history reviewable: a diff shows the
 * fields that changed instead of one rewritten line. Readers parse JSON, so the format
 * is free to change; sorting also makes the bytes independent of CMS key order.
 */
export function stableJson(value) {
  const ordered = (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry;
  return `${JSON.stringify(value, ordered, 2)}\n`;
}

// Large derived data and the impact snapshot live in their own files, so
// publication.json stays small and unchanged parts keep their Git blobs. Fields
// that a build engine's own scripts read from publication.json (media,
// extensions, fonts, settings, reference mapping) stay in it: engines in
// customer accounts do not update with Core.
const SPLIT_FIELDS = ['source_impact_snapshot'];
const DERIVED_FILE_BYTES = 512 * 1024;
const fileSafe = value => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && !value.includes('..');

function derivedFiles(derived, files) {
  // A list, not an object: stableJson sorts keys, and source order is part of the hashed data.
  const index = [];
  for (const [source, records] of Object.entries(derived)) {
    if (!fileSafe(source)) throw Error('Invalid derived source identity');
    const names = [];
    // Key order is kept: the build hashes derived data into its public URL.
    const write = value => { const name = `content/derived/${source}/${String(names.length).padStart(4, '0')}.json`; files[name] = `${JSON.stringify(value, null, 2)}\n`; names.push(name); };
    if (!Array.isArray(records)) write(records);
    else {
      // Size-bounded parts: an edit to one record changes one part, the others keep their blobs.
      let part = [], size = 0;
      for (const record of records) {
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (part.length && size + bytes > DERIVED_FILE_BYTES) { write(part); part = []; size = 0; }
        part.push(record); size += bytes;
      }
      if (part.length || !names.length) write(part);
    }
    index.push({ source, array: Array.isArray(records), files: names });
  }
  return index;
}

/** Stable per-record files keep a one-page edit from resending every page to Git. */
export function publicationContentFiles(publication) {
  const metadata = { ...publication }, files = {}, contentFiles = {};
  if (metadata.derived && typeof metadata.derived === 'object' && !Array.isArray(metadata.derived) && Object.keys(metadata.derived).length) {
    contentFiles.derived = derivedFiles(metadata.derived, files);
    delete metadata.derived;
  }
  for (const field of SPLIT_FIELDS) {
    if (metadata[field] === undefined) continue;
    const name = `content/metadata/${field}.json`;
    files[name] = stableJson(metadata[field]);
    (contentFiles.metadata ??= {})[field] = name;
    delete metadata[field];
  }
  for (const kind of ['pages', 'partials', 'menus', 'pageTemplates', 'blockTypes', 'contentTypes']) {
    const records = metadata[kind];
    if (!Array.isArray(records)) continue;
    const names = [], seen = new Set();
    for (const record of records) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(record.id) || seen.has(record.id)) throw Error('Invalid publication record identity');
      seen.add(record.id);
      const name = `content/${kind}/${record.id}.json`;
      files[name] = stableJson(record);
      names.push(name);
    }
    delete metadata[kind];
    contentFiles[kind] = names;
  }
  return { ...files, 'publication.json': stableJson({ ...metadata, content_files: contentFiles }) };
}

export async function readPublicationContent(metadata, readFile, manifest) {
  if (!metadata.content_files) return metadata;
  const { content_files: { derived, metadata: fields, ...index }, ...publication } = metadata;
  const verified = name => { if (typeof name !== 'string' || !Object.hasOwn(manifest.files, name)) throw Error('Unverified publication record'); return name; };
  if (derived !== undefined) {
    if (!Array.isArray(derived) || new Set(derived.map(entry => entry?.source)).size !== derived.length) throw Error('Invalid publication content index');
    publication.derived = {};
    for (const entry of derived) {
      const source = entry?.source;
      if (typeof source !== 'string' || !fileSafe(source) || !Array.isArray(entry?.files) || !entry.files.length || entry.files.some(name => typeof name !== 'string' || !name.startsWith(`content/derived/${source}/`) || !/^content\/derived\/[a-zA-Z0-9._-]+\/[0-9]{4}\.json$/.test(name))) throw Error('Invalid publication content index');
      const parts = [];
      for (const name of entry.files) parts.push(JSON.parse(await readFile(verified(name))));
      publication.derived[source] = entry.array ? parts.flat() : parts[0];
    }
  }
  for (const [field, name] of Object.entries(fields ?? {})) {
    if (!SPLIT_FIELDS.includes(field) || name !== `content/metadata/${field}.json`) throw Error('Invalid publication content index');
    publication[field] = JSON.parse(await readFile(verified(name)));
  }
  for (const [kind, names] of Object.entries(index)) {
    if (!['pages', 'partials', 'menus', 'pageTemplates', 'blockTypes', 'contentTypes'].includes(kind) || !Array.isArray(names) || new Set(names).size !== names.length) throw Error('Invalid publication content index');
    publication[kind] = [];
    // Keep large exports below the host's open-file limit.
    for (let offset = 0; offset < names.length; offset += 32) publication[kind].push(...await Promise.all(names.slice(offset, offset + 32).map(async name => {
      if (typeof name !== 'string' || !new RegExp(`^content/${kind}/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\\.json$`).test(name) || !Object.hasOwn(manifest.files, name)) throw Error('Unverified publication record');
      const record = JSON.parse(await readFile(name));
      if (name !== `content/${kind}/${record.id}.json`) throw Error('Publication record identity mismatch');
      return record;
    })));
  }
  return publication;
}
