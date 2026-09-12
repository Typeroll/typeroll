import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './customer-publishing.mjs';
import { projectPublicationBlocks, projectPublicationBlockTypes, projectPublicationData, projectPublicationSchema } from './publication-blocks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const stringFields = {
  site: ['name', 'domain', 'domain_alias'],
  settings: ['site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192', 'scripts_head', 'scripts_body_end', 'custom_css', 'language', 'twitter_handle', 'default_seo_suffix', 'default_meta_description', 'image_sizes_default', 'default_og_image', 'robots_txt', 'trailing_slash'],
  page: ['id', 'template', 'title', 'slug', 'path', 'parent', 'content_mode', 'html_content', 'custom_css', 'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'lastmod_override', 'json_ld', 'kind', 'schema_type', 'author', 'image_sizes_default', 'status', 'date_updated', 'date_published'],
  partial: ['id', 'name', 'kind', 'content_mode', 'html_content', 'status', 'date_updated'],
  media: ['id', 'filename', 'cdn_url', 'alt_text', 'title', 'caption', 'mime_type'],
};

function projectStrings(value, fields) {
  const output = {};
  for (const field of fields) {
    if (value?.[field] === undefined || value[field] === null) continue;
    if (typeof value[field] !== 'string') throw new Error(`Invalid public field type: ${field}`);
    output[field] = value[field];
  }
  return output;
}

function projectNumbers(value, fields) {
  const output = {};
  for (const field of fields) {
    if (value?.[field] === undefined) continue;
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) throw new Error(`Invalid public number: ${field}`);
    output[field] = value[field];
  }
  return output;
}

function projectBooleans(value, fields) {
  const output = {};
  for (const field of fields) {
    // API replacement clears optional fields to null; omission uses the default.
    if (value?.[field] === undefined || value[field] === null) continue;
    if (typeof value[field] !== 'boolean') throw new Error(`Invalid public flag: ${field}`);
    output[field] = value[field];
  }
  return output;
}

function projectStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid public string array: ${label}`);
  return [...value];
}

function assertIdentity(doc) {
  if (!safeId.test(doc.id ?? '')) throw new Error('Invalid public document ID');
  return doc;
}

function assertPublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Public asset URLs must be permanent HTTPS URLs without credentials or query parameters');
  return value;
}

/** Explicit public projection; unsupported runtime modules fail before a Git write. */
/** @param {any} input @param {{siteUrl: string, coreCommit: string, publishedAt: string, noindex?: boolean, coreBlockTypes?: readonly any[], versionId?: string}} options */
export function projectStaticPublication(input, { siteUrl, coreCommit, publishedAt, noindex = true, coreBlockTypes = [], versionId = input.versionId ?? 'main' }) {
  assertPublicUrl(siteUrl);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(versionId)) throw new Error('Invalid publication version ID');
  if (input.versionId !== undefined && input.versionId !== versionId) throw new Error('Publication version mismatch');
  const gitBranch = versionId === 'main' ? 'main' : `version-${versionId}`;
  if (!/^[a-f0-9]{40}$/.test(coreCommit) || !Number.isFinite(Date.parse(publishedAt))) throw new Error('Publication identity is required');
  for (const field of ['forms', 'extensions', 'collections']) {
    if (!Array.isArray(input[field])) throw new Error(`Invalid publication ${field}`);
    if (field !== 'collections' && input[field].length && !input.publicRuntime) throw new Error(`Publication requires a public runtime projection for ${field}`);
  }
  if (input.apps && Object.values(input.apps.apps ?? {}).some((app) => app.enabled) && !input.publicRuntime) throw new Error('Publication requires a public runtime projection for active Core modules');
  const blockTypes = projectPublicationBlockTypes(input.blockTypes, coreBlockTypes);
  const definitions = [...coreBlockTypes, ...blockTypes];
  const collections = input.collections.map(({ definition, items }) => {
    if (!definition || typeof definition !== 'object' || !Array.isArray(items)) throw new Error('Invalid publication collection');
    const projected = assertIdentity(projectStrings(definition, ['id', 'name', 'label_singular', 'label_plural', 'icon', 'slug_field', 'sort_field', 'sort_dir', 'route_template', 'schema_type', 'item_template_html']));
    if (!safeId.test(projected.name ?? '') || !Array.isArray(items)) throw new Error('Invalid publication collection');
    projected.fields = projectPublicationSchema(definition.fields);
    if (definition.item_template_blocks) projected.item_template_blocks = projectPublicationBlocks(definition.item_template_blocks, definitions);
    if (definition.schema_field_map) projected.schema_field_map = projectStrings(definition.schema_field_map, projected.fields.map(field => field.name));
    if (definition.facets) projected.facets = definition.facets.map(facet => ({ ...projectStrings(facet, ['field', 'base_path', 'label_singular', 'template']), ...projectNumbers(facet, ['min_items']) }));
    if (definition.facet_combinations) {
      if (!Array.isArray(definition.facet_combinations) || definition.facet_combinations.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(field => typeof field !== 'string'))) throw new Error('Invalid publication facet combinations');
      projected.facet_combinations = definition.facet_combinations.map(pair => [...pair]);
    }
    const publishedItems = items.filter(item => item.status === 'published').map(item => assertIdentity({
      ...projectPublicationData(item, definition.fields), ...projectStrings(item, ['id', 'status', 'created_at', 'updated_at']),
    }));
    publishedItems.sort((a, b) => a.id.localeCompare(b.id));
    return { definition: projected, items: publishedItems };
  }).sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  const forms = (input.publicRuntime?.forms ?? []).map(form => {
    const projected = assertIdentity(projectStrings(form, ['id', 'name', 'kind', 'submit_text', 'success_message', 'styles', 'submit_url', 'submit_token', 'session_param', 'hydrate_url']));
    Object.assign(projected, projectNumbers(form, ['pow_bits']));
    projected.steps = (form.steps ?? []).map(step => ({ ...projectStrings(step, ['id', 'title', 'render', 'next']), blocks: projectPublicationBlocks(step.blocks ?? [], definitions) }));
    return projected;
  });
  const settings = projectStrings(input.settings, stringFields.settings);
  if (input.settings?.contact) {
    settings.contact = projectStrings(input.settings.contact, ['email', 'phone']);
    const address = input.settings.contact.address;
    if (address !== undefined) settings.contact.address = typeof address === 'string' ? address :
      projectStrings(address, ['street_address', 'postal_code', 'address_locality', 'address_region', 'address_country']);
  }
  if (input.settings?.social) settings.social = projectStrings(input.settings.social, ['facebook', 'instagram', 'linkedin', 'x', 'youtube']);
  if (input.settings?.cookie_consent) settings.cookie_consent = {
    ...projectStrings(input.settings.cookie_consent, ['text', 'privacy_policy_url', 'scripts_necessary', 'scripts_optional']),
    ...projectBooleans(input.settings.cookie_consent, ['enabled', 'reload_after_consent']),
  };
  if (input.settings?.organization) {
    settings.organization = projectStrings(input.settings.organization, ['name', 'logo']);
    if (input.settings.organization.same_as !== undefined) settings.organization.same_as = projectStringArray(input.settings.organization.same_as, 'organization.same_as');
  }
  if (input.settings?.iframe_allowed_hosts !== undefined) settings.iframe_allowed_hosts = projectStringArray(input.settings.iframe_allowed_hosts, 'iframe_allowed_hosts');
  settings.colors = projectStrings(input.settings?.colors, ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'text_light']);
  settings.fonts = { ...projectStrings(input.settings?.fonts, ['heading', 'body']), ...projectNumbers(input.settings?.fonts, ['size_base']) };
  settings.sitewide_noindex = versionId !== 'main' || noindex || input.settings?.sitewide_noindex === true;
  const pages = input.pages.filter((page) => ['published', 'unlisted'].includes(page.status)).map((page) => {
    if (!['html', 'blocks'].includes(page.content_mode)) throw new Error('Unsupported publication page configuration');
    const projected = assertIdentity({ ...projectStrings(page, stringFields.page), ...projectBooleans(page, ['append_seo_suffix', 'noindex']), ...projectNumbers(page, ['sort_order']) });
    if (page.alternates !== undefined && page.alternates !== null) {
      if (!Array.isArray(page.alternates)) throw new Error('Invalid publication language alternatives');
      projected.alternates = page.alternates.map(alternate => projectStrings(alternate, ['hreflang', 'href']));
    }
    if (page.service) projected.service = { ...projectStrings(page.service, ['price_currency', 'duration', 'description', 'url']),
      ...(typeof page.service.price === 'number' ? projectNumbers(page.service, ['price']) : projectStrings(page.service, ['price'])) };
    if (page.content_mode === 'blocks') {
      delete projected.html_content;
      projected.blocks = projectPublicationBlocks(page.blocks, definitions);
    }
    return projected;
  });
  const partials = input.partials.filter((partial) => partial.status === 'published').map((partial) => {
    if (!['html', 'blocks'].includes(partial.content_mode)) throw new Error('Unsupported publication partial configuration');
    const projected = assertIdentity(projectStrings(partial, stringFields.partial));
    if (partial.content_mode === 'blocks') {
      delete projected.html_content;
      projected.blocks = projectPublicationBlocks(partial.blocks, definitions);
    }
    return projected;
  });
  if (!Array.isArray(input.pageTemplates)) throw new Error('Invalid publication page templates');
  const referencedTemplates = new Set([...pages.map(page => page.template), ...collections.flatMap(collection => (collection.definition.facets ?? []).map(facet => facet.template))].filter(Boolean));
  const pageTemplates = input.pageTemplates.filter(template => referencedTemplates.has(template.id)).map(template => {
    if (template.status !== 'published') throw new Error('Referenced publication page template is not published');
    return assertIdentity({ ...projectStrings(template, ['id', 'name', 'label', 'status']),
      blocks: projectPublicationBlocks(template.blocks, [...definitions, { id: 'template_content_slot', schema: [] }]),
    });
  });
  if (pageTemplates.length !== referencedTemplates.size) throw new Error('Publication page template is missing');
  if (!Array.isArray(input.redirects)) throw new Error('Invalid publication redirects');
  const redirects = input.redirects.map(redirect => {
    const result = projectStrings(redirect, ['id', 'from_path', 'to_path']);
    // Redirect write paths preserve filename dots and generate leading underscores
    // for wildcard routes. Keep those identities without permitting path traversal.
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(result.id ?? '') || ['.', '..'].includes(result.id)) {
      throw new Error('Invalid publication redirect ID');
    }
    if (!result.from_path?.startsWith('/') || result.from_path.startsWith('//') || !result.to_path ||
      /[\s\x00-\x1f]/.test(result.from_path + result.to_path) || ![301, 302].includes(redirect.status_code)) throw new Error('Invalid publication redirect');
    return { ...result, status_code: redirect.status_code };
  });
  const renderedContent = JSON.stringify({ settings, pages, partials, blockTypes, pageTemplates, collections, forms });
  const referencedMedia = input.media.filter((item) => [item.cdn_url, ...(item.variants ?? []).map((variant) => variant.cdn_url)]
    .some((url) => typeof url === 'string' && url.length > 0 && renderedContent.includes(url)));
  const media = referencedMedia.map((item) => {
    const projected = assertIdentity({ ...projectStrings(item, stringFields.media), ...projectNumbers(item, ['width', 'height', 'size_bytes']) });
    assertPublicUrl(projected.cdn_url);
    projected.variants = (item.variants ?? []).map((variant) => {
      if (!['jpeg', 'webp', 'avif'].includes(variant.format)) throw new Error('Invalid media variant format');
      return { ...projectStrings(variant, ['format', 'cdn_url']), ...projectNumbers(variant, ['width', 'size_bytes']), cdn_url: assertPublicUrl(variant.cdn_url) };
    });
    return projected;
  });
  for (const list of [pages, partials, media, blockTypes, pageTemplates, redirects]) {
    list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(list.map((item) => item.id)).size !== list.length) throw new Error('Duplicate public document ID');
  }
  const publication = {
    format: 'typeroll-static-publication', format_version: 1,
    publication_id: digest(JSON.stringify({ siteUrl, coreCommit, publishedAt, versionId })),
    version_id: versionId, git_branch: gitBranch,
    core_commit: coreCommit, published_at: publishedAt, site_url: siteUrl,
    site: projectStrings(input.site, stringFields.site), settings, pages, partials, media, blockTypes, pageTemplates, redirects,
    collections, forms,
    apps: input.publicRuntime?.apps ?? { apps: {} },
    extensions: input.publicRuntime?.extensions ?? { installations: [] },
    runtime_dependencies: input.publicRuntime?.dependencies ?? [],
  };
  // This is an additional tripwire; field projection, not regex, is the privacy boundary.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,}/.test(JSON.stringify(publication))) {
    throw new Error('Credential-like value found in public content; review before publication');
  }
  return publication;
}

async function copySources(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === '__tests__' || /\.(test|spec)\./.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copySources(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
    else throw new Error('Renderer source must not contain symlinks');
  }
}

export async function createStaticPublicationProject(publication, destination) {
  if (publication.format !== 'typeroll-static-publication' || publication.format_version !== 1) throw new Error('Unsupported publication format');
  await fs.mkdir(destination, { recursive: false });
  const json = async (file, data) => {
    await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await fs.writeFile(path.join(destination, file), `${JSON.stringify(data, null, 2)}\n`);
  };
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const version = (name) => lock.packages[`node_modules/${name}`].version;
  await json('package.json', {
    name: 'typeroll-published-site', version: '1.0.0', private: true, type: 'module',
    engines: { node: '>=22.12.0' }, workspaces: ['packages/shared', 'packages/site-template'],
    scripts: { build: 'node scripts/build.mjs' }, dependencies: { esbuild: version('esbuild'), pagefind: version('pagefind'), sharp: version('sharp'), '@aws-sdk/client-s3': version('@aws-sdk/client-s3') },
  });
  await json('packages/site-template/package.json', {
    name: '@typeroll/site-template', version: '0.1.0', private: true, type: 'module',
    scripts: { build: 'astro build' },
    dependencies: { '@typeroll/shared': '*', astro: version('astro'), 'sanitize-html': version('sanitize-html') },
  });
  const sharedPackage = JSON.parse(await fs.readFile(path.join(root, 'packages/shared/package.json'), 'utf8'));
  await json('packages/shared/package.json', {
    name: sharedPackage.name, version: sharedPackage.version, private: true, type: 'module',
    main: sharedPackage.main, types: sharedPackage.types, exports: sharedPackage.exports,
  });
  await copySources(path.join(root, 'packages/site-template/src'), path.join(destination, 'packages/site-template/src'));
  await copySources(path.join(root, 'packages/shared/src'), path.join(destination, 'packages/shared/src'));
  await fs.copyFile(path.join(root, 'packages/site-template/astro.config.mjs'), path.join(destination, 'packages/site-template/astro.config.mjs'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE.typeroll'));
  await copySources(path.join(root, 'scripts/fixtures/static-publication'), path.join(destination, 'scripts'));
  await fs.copyFile(path.join(destination, 'scripts/datastore.ts'), path.join(destination, 'packages/site-template/src/lib/datastore.ts'));
  await fs.rm(path.join(destination, 'scripts/datastore.ts'));
  await fs.mkdir(path.join(destination, 'scripts/source'), { recursive: true });
  for (const module of ['bundle-blocks', 'search-index', 'pages-headers']) {
    await fs.copyFile(path.join(root, `packages/portal/src/lib/deploy/${module}.ts`), path.join(destination, `scripts/source/${module}.ts`));
  }
  await fs.mkdir(path.join(destination, 'scripts/source/extensions'), { recursive: true });
  for (const module of ['assets', 'public-http']) await fs.copyFile(path.join(root, `packages/portal/src/lib/extensions/${module}.ts`), path.join(destination, `scripts/source/extensions/${module}.ts`));
  await json('publication.json', publication);
  await fs.writeFile(path.join(destination, '.gitignore'), 'node_modules/\ndist/\n.astro/\n.publication-work/\n.publication-media/\n.env*\n');
  await fs.writeFile(path.join(destination, 'README.md'), '# Generated Typeroll publication\n\nEdit in Typeroll. Publishing replaces this entire generated tree; manual repository changes are unsupported.\n\nRun `npm ci` and `npm run build` using Node 22.23.1. The static output is `dist/`. All renderer source and public content are included. Builds never contact Typeroll Cloud. Images stay in customer-owned R2 storage and are never committed to this repository. Builds read and verify the originals with temporary, object-specific R2 access from `TYPEROLL_BUILD_MEDIA_ACCESS`, generate responsive variants, and publish the assets. Independent builds can supply R2 credentials with account_id, original_bucket, public_bucket, original and public fields in the same environment variable; preserve the original storage and frozen media manifest.\n\nThe frozen publication includes public HTML, blocks, templates, collections and runtime configuration. Forms, Apps and Extensions can depend on the endpoints listed in `runtime_dependencies` in `publication.json`. Building the static pages does not replace those services. This repository is not a full CMS backup.\n\nThe vendored Typeroll renderer and shared code use LICENSE.typeroll. Site content retains its existing terms.\n');
  return { pages: publication.pages.length, partials: publication.partials.length, media: publication.media.length };
}

export async function sealPublicationProject(destination) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.astro', '.git', '.publication-work', '.publication-media', 'publication-manifest.json'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) files[relative] = digest(await fs.readFile(path.join(directory, entry.name)));
      else throw new Error('Publication contains a symlink');
    }
  }
  await walk(destination);
  if (!files['package-lock.json']) throw new Error('Generate the dependency lock before sealing the publication');
  const manifest = { format_version: 1, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1)) };
  await fs.writeFile(path.join(destination, 'publication-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files: Object.keys(files).length, digest: digest(JSON.stringify(manifest)) };
}
