import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './customer-publishing.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const stringFields = {
  site: ['name', 'domain', 'domain_alias'],
  settings: ['site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192', 'scripts_head', 'scripts_body_end', 'custom_css', 'language', 'twitter_handle', 'default_seo_suffix', 'default_meta_description', 'image_sizes_default', 'default_og_image', 'robots_txt', 'trailing_slash'],
  page: ['id', 'title', 'slug', 'path', 'parent', 'content_mode', 'html_content', 'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'lastmod_override', 'json_ld', 'kind', 'schema_type', 'author', 'image_sizes_default', 'status', 'date_updated', 'date_published'],
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
    if (value?.[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') throw new Error(`Invalid public flag: ${field}`);
    output[field] = value[field];
  }
  return output;
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

/** Initial, deliberately bounded contract for HTML sites without runtime modules. */
export function projectStaticPublication(input, { siteUrl, coreCommit, publishedAt, noindex = true }) {
  assertPublicUrl(siteUrl);
  if (!/^[a-f0-9]{40}$/.test(coreCommit) || !Number.isFinite(Date.parse(publishedAt))) throw new Error('Publication identity is required');
  for (const field of ['forms', 'extensions', 'collections', 'blockTypes', 'pageTemplates', 'redirects']) {
    if (!Array.isArray(input[field]) || input[field].length) throw new Error(`Initial static publication does not support ${field}`);
  }
  if (input.apps && Object.values(input.apps.apps ?? {}).some((app) => app.enabled)) throw new Error('Initial static publication does not support active Core modules');
  const settings = projectStrings(input.settings, stringFields.settings);
  for (const field of ['contact', 'social', 'cookie_consent', 'organization', 'iframe_allowed_hosts']) {
    if (input.settings?.[field] !== undefined) throw new Error(`Initial static publication does not yet project ${field}`);
  }
  settings.colors = projectStrings(input.settings?.colors, ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'text_light']);
  settings.fonts = { ...projectStrings(input.settings?.fonts, ['heading', 'body']), ...projectNumbers(input.settings?.fonts, ['size_base']) };
  settings.sitewide_noindex = noindex || input.settings?.sitewide_noindex === true;
  const pages = input.pages.filter((page) => ['published', 'unlisted'].includes(page.status)).map((page) => {
    if (page.content_mode !== 'html' || page.blocks?.length || page.template || page.alternates || page.service) throw new Error('Initial static publication requires plain HTML pages');
    return assertIdentity({ ...projectStrings(page, stringFields.page), ...projectBooleans(page, ['append_seo_suffix', 'noindex']), ...projectNumbers(page, ['sort_order']) });
  });
  const partials = input.partials.filter((partial) => partial.status === 'published').map((partial) => {
    if (partial.content_mode !== 'html' || partial.blocks?.length) throw new Error('Initial static publication requires HTML partials');
    return assertIdentity(projectStrings(partial, stringFields.partial));
  });
  if (!pages.length) throw new Error('Publication has no published pages');
  const renderedContent = JSON.stringify({ settings, pages, partials });
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
  for (const list of [pages, partials, media]) {
    list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(list.map((item) => item.id)).size !== list.length) throw new Error('Duplicate public document ID');
  }
  const publication = {
    format: 'typeroll-static-publication', format_version: 1,
    core_commit: coreCommit, published_at: publishedAt, site_url: siteUrl,
    site: projectStrings(input.site, stringFields.site), settings, pages, partials, media,
    runtime_dependencies: [],
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
    scripts: { build: 'node scripts/build.mjs' }, dependencies: { esbuild: version('esbuild'), pagefind: version('pagefind') },
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
  await json('publication.json', publication);
  await fs.writeFile(path.join(destination, '.gitignore'), 'node_modules/\ndist/\n.astro/\n.publication-work/\n.env*\n');
  await fs.writeFile(path.join(destination, 'README.md'), '# Generated Typeroll publication\n\nEdit in Typeroll. Publishing replaces this entire generated tree; manual repository changes are unsupported.\n\nRun `npm ci` and `npm run build` using Node 22.23.1. The static output is `dist/`. All renderer source and public content are included. Builds never contact Typeroll Cloud. Existing media is served directly from the URLs in `publication.json`; preserve or mirror that customer-owned storage separately.\n\nThis initial publication supports HTML sites without Forms, Apps, Extensions, collections or custom block templates. It is not a full CMS backup.\n\nThe vendored Typeroll renderer and shared code use LICENSE.typeroll. Site content retains its existing terms.\n');
  return { pages: publication.pages.length, partials: publication.partials.length, media: publication.media.length };
}

export async function sealPublicationProject(destination) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.astro', '.git', '.publication-work', 'publication-manifest.json'].includes(entry.name)) continue;
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
