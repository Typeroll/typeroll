const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mediaBoundary = '(?=[?#\\s"\'<>),\\]\\\\]|$)';
const originBoundary = '(?=[/?#\\s"\'<>),\\]\\\\]|$)';

/** Match the source once instead of rescanning it for each library URL. */
export function findReferences(text, references) {
  const keys = [...new Set(references)].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (!keys.length) return new Set();
  const pattern = new RegExp(`(?:${keys.map(escape).join('|')})${mediaBoundary}`, 'g');
  return new Set([...text.matchAll(pattern)].map(match => match[0]));
}

/** Compile once per publication, never once per field/alias pair. Do not cascade replacements. */
export function replaceReferences(value, replacements, { origins = false, skipCanonical = !origins } = {}) {
  const entries = [...replacements].filter(([from, to]) => from && from !== to).sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  if (!entries.length) return value;
  const targets = new Map(entries);
  const pattern = new RegExp(`(?:${entries.map(([from]) => escape(from)).join('|')})${origins ? originBoundary : mediaBoundary}`, 'g');
  const visit = (input, field = '') => {
    if (typeof input === 'string') return skipCanonical && field === 'canonical_url' ? input : input.replace(pattern, from => targets.get(from));
    if (Array.isArray(input)) return input.map(item => visit(item));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item, key)]));
    return input;
  };
  return visit(value);
}

/** The generated repository carries every input; resolving references never calls the CMS. */
export function resolvePublicationReferences(publication) {
  const mapping = publication.reference_mapping;
  if (!mapping) return publication;
  if (mapping.format !== 1 || !Array.isArray(mapping.media) || !Array.isArray(mapping.website_origins)) throw Error('Invalid publication reference mapping');
  const { reference_mapping: ignored, ...source } = publication;
  void ignored;
  for (const pair of mapping.media) if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) throw Error('Invalid publication media mapping');
  const { media, media_manifest, retained_media_manifests, source_impact_snapshot, ...body } = source;
  const content = replaceReferences(body, mapping.media);
  const target = new URL(publication.site_url).origin;
  const origins = mapping.website_origins.map(value => [new URL(value).origin, target]);
  // Storage manifests describe exact frozen object paths and aliases, not authored links.
  const authored = content;
  const resolved = replaceReferences(authored, origins, { origins: true });
  if (/\/api\/sites\/[a-zA-Z0-9_%.-]+\/media\/[a-zA-Z0-9_%.-]+\/content(?=[?#\s"'<>),\]\\]|$)/.test(JSON.stringify(resolved))) throw Error('Publication contains unresolved private media');
  return { ...resolved, media, media_manifest, retained_media_manifests, source_impact_snapshot };
}
