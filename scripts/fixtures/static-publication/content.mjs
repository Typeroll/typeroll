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

/** Stable per-record files keep a one-page edit from resending every page to Git. */
export function publicationContentFiles(publication) {
  const metadata = { ...publication }, files = {}, contentFiles = {};
  for (const kind of ['pages', 'partials', 'pageTemplates', 'blockTypes', 'contentTypes']) {
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
  const { content_files: index, ...publication } = metadata;
  for (const [kind, names] of Object.entries(index)) {
    if (!['pages', 'partials', 'pageTemplates', 'blockTypes', 'contentTypes'].includes(kind) || !Array.isArray(names) || new Set(names).size !== names.length) throw Error('Invalid publication content index');
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
