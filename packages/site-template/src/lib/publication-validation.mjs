import { parseDocument } from 'htmlparser2';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, readFileSync } from 'node:fs';
import { robotsAllows } from './robots-policy.mjs';

// Change with every change in validation semantics; never cache a prior verdict.
export const SEO_VALIDATOR_VERSION = 1;
const hash = value => createHash('sha256').update(value).digest('hex');
export const outputDigest = files => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, f]) => [name, f.sha256, f.size])));
const children = node => node.children ?? [];
const nodes = node => children(node).flatMap(child => [child, ...nodes(child)]);
const text = node => node.type === 'text' ? node.data : children(node).map(text).join('');
const attr = (node, key) => node.attribs?.[key] ?? '';
const visibleText = node => ['script', 'style', 'template'].includes(node.name) || node.attribs?.hidden !== undefined || attr(node, 'aria-hidden') === 'true' ? '' : node.type === 'text' ? node.data : children(node).map(visibleText).join('');
const norm = value => value.replace(/\s+/g, ' ').trim();
const route = name => name === 'index.html' ? '/' : name.endsWith('/index.html') ? '/' + name.slice(0, -10) : '/' + name;
const key = pathname => decodeURI(pathname).replace(/\/index\.html$/, '/').replace(/\/$/, '') || '/';
function headerRobots(source, url) {
  let matches = false; const tokens = [];
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/:[a-zA-Z_]+/g, '[^./]+');
      matches = new RegExp('^' + pattern + '$').test(line.startsWith('https://') ? url.href : url.pathname);
    } else if (matches && /^\s*X-Robots-Tag:/i.test(line)) tokens.push(...line.split(':').slice(1).join(':').trim().toLowerCase().split(/[\s,]+/));
  }
  return tokens;
}

/** Validate complete output, including HTML restored from the render cache.
 * No network crawl, bot impersonation, content rewriting, or cached verdicts.
 */
export function validatePublication({ files, publication, routes = [], sourceHash = '', configurationHash, reusedFiles = {} }) {
  const base = new URL(publication.site_url);
  const read = name => typeof files[name] === 'function' ? files[name]() : files[name];
  const errors = [], warnings = [];
  const index = new Map(), pages = [];
  const descriptors = { ...reusedFiles };
  const routeInfo = new Map(routes.map(entry => [key(entry.pathname), entry]));
  const metadata = { title: new Map(), description: new Map() };
  const add = (severity, code, page, node, message, remediation, field) => {
    const start = node?.startIndex ?? 0;
    let owner = node;
    while (owner && !attr(owner, 'data-source-block-id') && !attr(owner, 'data-block-id')) owner = owner.parent;
    const locator = { file: page.file, line: (page.html ?? '').slice(0, start).split('\n').length,
      ...(node?.name ? { element: node.name } : {}), ...(owner ? { block_id: attr(owner, 'data-source-block-id') || attr(owner, 'data-block-id') } : {}),
      ...(page.info?.page_id ? { page_id: page.info.page_id } : {}), ...(field ? { field } : {}) };
    (severity === 'error' ? errors : warnings).push({ code, url: page.url.slice(0, 2048), source: locator, message: message.slice(0, 4096), remediation: remediation.slice(0, 4096) });
  };
  for (const [file, content] of Object.entries(files)) {
    const value = typeof content === 'function' ? content() : content;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    descriptors[file] = { sha256: hash(bytes), size: bytes.length };
    index.set(key('/' + file), file);
    if (!file.endsWith('.html')) continue;
    const pathname = route(file), html = bytes.toString('utf8');
    const info = routeInfo.get(key(pathname));
    const page = { file, pathname, url: new URL(info?.pathname ?? pathname, base).href, info };
    const documentNodes = nodes(parseDocument(html, { withStartIndices: true }));
    page.robots = [...documentNodes.filter(n => n.name === 'meta' && ['robots', 'googlebot'].includes(attr(n, 'name').toLowerCase())).flatMap(n => attr(n, 'content').toLowerCase().split(/[\s,]+/)),
      ...headerRobots(String(read('_headers') ?? ''), new URL(page.url))];
    index.set(key(pathname), file); pages.push(page);
  }
  for (const name of Object.keys(reusedFiles)) index.set(key('/' + name), name);
  const byFile = new Map(pages.map(page => [page.file, page]));
  const redirects = String(read('_redirects') ?? '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const [from, to, status = '301'] = line.split(/\s+/);
    return { from, to, status: Number(status.replace('!', '')) };
  });
  function redirect(url) {
    for (const entry of redirects) {
      const source = new URL(entry.from, base);
      if (source.origin !== url.origin) continue;
      const names = [];
      const pattern = source.pathname.split(/(\*|:[a-zA-Z_][a-zA-Z0-9_]*)/).map(part => {
        if (part === '*') { names.push('splat'); return '(.*)'; }
        if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      const match = url.pathname.match(new RegExp('^' + pattern + '$'));
      if (match && entry.status >= 300 && entry.status < 400) return new URL(entry.to.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (token, name) => names.includes(name) ? match[names.indexOf(name) + 1] : token), url);
    }
  }
  function target(href, from) {
    let url;
    try { url = new URL(href, from); } catch { return { invalid: true }; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin) return { external: true, url };
    const visited = new Set(); let redirected = false;
    while (true) {
      if (visited.has(url.href)) return { loop: true, url };
      visited.add(url.href);
      if (visited.size > 32) return { loop: true, url };
      const next = redirect(url);
      if (!next) break;
      redirected = true; url = next;
      if (url.origin !== base.origin) return { external: true, redirected, url };
    }
    let file;
    try { file = index.get(key(url.pathname)); } catch { return { invalid: true, url }; }
    return { file, page: byFile.get(file), url, redirected };
  }
  for (const entry of redirects) {
    const probe = entry.from.replace(/\*/g, 'typeroll-route-probe').replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, 'typeroll-route-probe');
    if (target(probe, base).loop) add('error', 'redirect_loop', { file: '_redirects', html: String(read('_redirects')), url: new URL(entry.from, base).href }, null, `Redirect loop at ${entry.from}`, 'Remove the cyclic redirect.', 'redirects');
  }
  for (const type of publication.contentTypes ?? []) {
    for (const [field, property] of Object.entries(type.schema_field_map ?? {})) {
      if (typeof property !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(property) || ['constructor', 'prototype', '__proto__'].includes(property)) {
        add('error', 'schema_mapping_unsupported', { file: `content/contentTypes/${type.id}.json`, html: '', url: base.href }, null,
          `Unsupported schema property ${String(property)}.`, 'Use a supported direct Schema.org property or remove this mapping; keep the underlying content field.', `schema_field_map.${field}`);
      }
    }
  }
  for (const page of pages) {
    page.html = String(read(page.file));
    const doc = parseDocument(page.html, { withStartIndices: true });
    const all = nodes(doc), title = norm(text(all.find(n => n.name === 'title') ?? {}));
    const description = all.filter(n => n.name === 'meta' && attr(n, 'name').toLowerCase() === 'description').map(n => norm(attr(n, 'content'))).join(' ');
    for (const [field, value] of Object.entries({ title, description })) {
      if (!value) add('warning', 'metadata_missing', page, null, `Missing ${field}.`, 'Review the page metadata.', field);
      else { const found = metadata[field].get(value.toLowerCase()) ?? []; found.push(page); metadata[field].set(value.toLowerCase(), found); }
    }
    if (/\b([\p{L}\p{N}]+)\s+\1\b/iu.test(title)) add('warning', 'title_repeated_word', page, null, `Repeated word in title: ${title}`, 'Remove accidental repetition after editorial review.', 'title');
    const canonicals = all.filter(n => n.name === 'link' && attr(n, 'rel').toLowerCase().split(/\s+/).includes('canonical'));
    const expectedCanonical = page.info?.canonical ?? page.url;
    if (canonicals.length !== 1 || attr(canonicals[0], 'href') !== expectedCanonical) add('error', 'canonical_conflict', page, canonicals[0], `Expected one canonical: ${expectedCanonical}`, 'Correct the canonical configuration or generated head.', 'canonical_url');
    if (!page.robots.includes('noindex') && !robotsAllows(String(read('robots.txt') ?? ''), page.pathname)) add('warning', 'crawl_policy_blocks_page', page, null, 'robots.txt disallows Googlebot on an indexable page.', 'Review crawler policy. This does not test verified Google access.', 'robots_txt');
    const crumbs = [];
    for (const node of all.filter(n => n.name === 'script' && attr(n, 'type').toLowerCase() === 'application/ld+json')) {
      let data;
      try { data = JSON.parse(text(node)); } catch { add('error', 'jsonld_malformed', page, node, 'Invalid JSON-LD.', 'Correct the structured-data source.', 'json_ld'); continue; }
      if (!data || typeof data !== 'object') { add('error', 'jsonld_malformed', page, node, 'JSON-LD must be an object or array of objects.', 'Correct the structured-data source.', 'json_ld'); continue; }
      function inspect(value) {
        if (!value || typeof value !== 'object') return;
        if (value['@type'] === 'BreadcrumbList') crumbs.push({ value, node });
        for (const [property, child] of Object.entries(value)) {
          if (/^(?:address|geo|offers)\./.test(property) || ['__proto__', 'prototype', 'constructor'].includes(property)) add('error', 'schema_property_invalid', page, node, `Invalid structured-data key: ${property}`, 'Use a supported schema mapping.', `json_ld.${property}`);
          inspect(child);
        }
      }
      inspect(data);
    }
    const expectedCrumbs = page.info?.breadcrumbs;
    if ((page.pathname === '/' && crumbs.length) || crumbs.length > 1 || (expectedCrumbs?.length && crumbs.length !== 1)) add('error', 'breadcrumb_count', page, crumbs[0]?.node, 'Unexpected number of BreadcrumbList objects.', 'Use the single resolved breadcrumb structure.', 'breadcrumbs');
    for (const { value, node } of crumbs) {
      const items = value.itemListElement;
      if (!Array.isArray(items) || !items.length) { add('error', 'breadcrumb_invalid', page, node, 'BreadcrumbList has no items.', 'Use the resolved breadcrumb structure.', 'breadcrumbs'); continue; }
      items.forEach((item, i) => {
        const href = typeof item.item === 'string' ? item.item : item.item?.['@id'];
        const expected = expectedCrumbs?.[i]?.item ?? (i === items.length - 1 ? expectedCanonical : undefined);
        const resolved = typeof href === 'string' ? target(href, page.url) : { invalid: true };
        if (item.position !== i + 1 || (expected && href !== expected) || resolved.invalid || resolved.loop || (!resolved.external && (!resolved.file || resolved.redirected))) add('error', 'breadcrumb_route', page, node, `Breadcrumb ${i + 1} points to ${String(href)}${expected ? `; expected ${expected}` : ''}.`, 'Generate breadcrumbs from resolved page routes.', `breadcrumbs.${i}.item`);
      });
      if (expectedCrumbs && expectedCrumbs.length !== items.length) add('error', 'breadcrumb_route', page, node, 'Breadcrumb ancestors differ from resolved routes.', 'Use the resolved breadcrumb structure.', 'breadcrumbs');
    }
    const links = all.filter(n => n.name === 'a' && attr(n, 'href'));
    for (const link of links) {
      const href = attr(link, 'href');
      // Client-side filters and generated anchors are not new routes.
      if (!href.startsWith('#')) {
        const result = target(href, page.url);
        if (result.invalid || result.loop || (!result.external && !result.file)) add('error', 'internal_target_missing', page, link, `Broken internal target: ${href}`, 'Fix the link or create the intended route.');
        else if (result.redirected) add('warning', 'internal_redirect', page, link, `Link redirects: ${href}`, 'Use the final destination where appropriate.');
      }
      const descendants = nodes(link), images = descendants.filter(n => n.name === 'img');
      const labelled = attr(link, 'aria-labelledby').split(/\s+/).filter(Boolean).map(id => text(all.find(n => attr(n, 'id') === id) ?? {})).join(' ');
      const name = [attr(link, 'aria-label'), labelled, visibleText(link), images.map(n => attr(n, 'alt')).join(' '), attr(link, 'title')].map(norm).find(Boolean) ?? '';
      if (images.length && !name) add('error', 'image_link_unnamed', page, link, `Image link has no accessible name: ${href}`, 'Supply meaningful image alt, image_alt_field, or a card title.');
      if (/^(?:about|click here|read more|learn more|explore companies and programs)$/i.test(name)) add('warning', 'generic_link_text', page, link, `Review generic link text: ${name}`, 'Make the destination clear in context; do not add keywords mechanically.');
    }
    let previousHeading = 0;
    for (const heading of all.filter(n => /^h[1-6]$/.test(n.name ?? ''))) {
      const level = Number(heading.name[1]);
      if (previousHeading && level > previousHeading + 1) add('warning', 'heading_jump', page, heading, `Heading jumps from H${previousHeading} to H${level}: ${norm(text(heading))}`, 'Review the document hierarchy.');
      previousHeading = level;
    }
    for (const list of all.filter(n => ['ul', 'ol'].includes(n.name) || ['core/page_list', 'core/repeater'].includes((attr(n, 'data-source-block-type') || attr(n, 'data-block-type'))))) {
      const destinations = new Map();
      for (const link of nodes(list).filter(n => n.name === 'a' && attr(n, 'href'))) {
        // An image/title pair within the same card is one destination context.
        let context = link.parent;
        while (context?.parent && context.parent !== list && !['li', 'article'].includes(context.name)) context = context.parent;
        const dest = attr(link, 'href'); const seen = destinations.get(dest) ?? new Set(); seen.add(context); destinations.set(dest, seen);
      }
      for (const [dest, contexts] of destinations) if (contexts.size > 1) add('warning', 'list_destination_repeated', page, list, `Destination repeated in one list: ${dest}`, 'Review this list; repetition in separate contexts is allowed.');
    }
    const publicText = norm(visibleText(all.find(n => n.name === 'body') ?? doc));
    const review = publication.settings?.seo_review ?? {};
    const editorialLocation = phrase => {
      const needle = phrase.toLowerCase();
      if (title.toLowerCase().includes(needle)) return { node: all.find(n => n.name === 'title'), field: 'seo_title' };
      if (description.toLowerCase().includes(needle)) return { node: all.find(n => n.name === 'meta' && attr(n, 'name').toLowerCase() === 'description'), field: 'seo_description' };
      const body = all.find(n => n.name === 'body') ?? doc;
      const matching = nodes(body).find(n => {
        if (n.type !== 'text' || !norm(n.data).toLowerCase().includes(needle)) return false;
        for (let parent = n.parent; parent && parent !== body; parent = parent.parent) if (['script', 'style', 'template'].includes(parent.name) || parent.attribs?.hidden !== undefined || attr(parent, 'aria-hidden') === 'true') return false;
        return true;
      });
      return { node: matching?.parent ?? body, field: 'body' };
    };
    const reviewText = (publicText + ' ' + title + ' ' + description).toLowerCase();
    for (const marker of review.forbidden_markers ?? []) if (reviewText.includes(marker.toLowerCase())) {
      const location = editorialLocation(marker);
      add('warning', 'forbidden_internal_marker', page, location.node, `Public copy contains configured marker: ${marker}`, 'Review and remove internal notes without inventing replacement facts.', location.field);
    }
    for (const rule of review.claims ?? []) if (reviewText.includes(rule.phrase.toLowerCase())) {
      const location = editorialLocation(rule.phrase);
      add('warning', 'editorial_claim_review', page, location.node, `Review configured claim: ${rule.phrase}`, rule.guidance, location.field);
    }
    if (page.robots.includes('nofollow') && !publication.robots_blocked && !publication.settings?.sitewide_nofollow && !page.info?.nofollow) add('warning', 'unexpected_nofollow', page, null, 'Navigation is marked nofollow without an explicit page or site decision.', 'Review link-following independently of indexability.', 'nofollow');
    delete page.html;
  }
  for (const [field, values] of Object.entries(metadata)) for (const group of values.values()) if (group.length > 1) for (const page of group) add('warning', 'metadata_duplicate', page, null, `${field} duplicates ${group.find(other => other !== page).url}`, 'Review whether these pages need distinct metadata.', field);
  for (const sitemapFile of Object.keys(files).filter(name => /(?:^|\/)sitemap[^/]*\.xml$/.test(name))) {
    const sitemap = read(sitemapFile);
    const xml = parseDocument(String(sitemap), { xmlMode: true, withStartIndices: true });
    for (const node of nodes(xml).filter(n => n.name === 'loc' && n.parent?.name === 'url')) {
      const href = text(node), result = target(href, base);
      if (result.external || result.invalid || result.loop || !result.page || result.redirected || result.page.robots.includes('noindex') || publication.robots_blocked || publication.settings?.sitewide_noindex) add('error', 'sitemap_route_invalid', { file: sitemapFile, html: String(sitemap), url: href }, node, `Sitemap URL is missing, redirected, or not indexable: ${href}`, 'Include only actual indexable routes in the sitemap.', 'sitemap');
    }
  }
  const report = { version: SEO_VALIDATOR_VERSION, publication_id: publication.publication_id, source_sha256: sourceHash,
    configuration_sha256: configurationHash ?? hash(JSON.stringify({ settings: publication.settings, contentTypes: publication.contentTypes })),
    artifact_tree_sha256: outputDigest(descriptors), checked_pages: pages.length, passed: errors.length === 0,
    error_count: errors.length, warning_count: warnings.length, errors: errors.slice(0, 100), warnings: warnings.slice(0, 100) };
  while (JSON.stringify(report).length > 180000 && report.errors.length + report.warnings.length > 1) (report.warnings.length ? report.warnings : report.errors).pop();
  return report;
}

export async function validatePublicationDirectory(dist, options) {
  const files = Object.create(null);
  const descriptors = { ...options.reusedFiles };
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('unsafe_build_output');
      if (entry.isDirectory()) await walk(file, name + '/');
      else if (name.endsWith('.html') || /(?:^|\/)sitemap[^/]*\.xml$/.test(name) || ['_headers', '_redirects', 'robots.txt'].includes(name)) files[name] = () => readFileSync(file);
      else {
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(file)) { digest.update(chunk); size += chunk.length; }
        descriptors[name] = { sha256: digest.digest('hex'), size };
      }
    }
  }
  await walk(dist);
  return validatePublication({ ...options, reusedFiles: descriptors, files });
}
