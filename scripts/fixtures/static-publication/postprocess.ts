import fs from 'node:fs/promises';
import path from 'node:path';
import { bundleBlockAssets } from './source/bundle-blocks';
import { buildSearchIndexIfUsed } from './source/search-index';
import { expandRedirectsForTrailingSlashPolicy, pagesShadowedByRedirect } from '@typeroll/shared';
import type { Redirect, TrailingSlashPolicy } from '@typeroll/shared';
import { buildPagesHeaders, withGlobalHeaders } from './source/pages-headers';
import { vendorExtensionAssets } from './source/extensions/assets';
import type { ExtensionRuntimeSnapshot } from '@typeroll/shared';

export async function postprocess(dist: string, publication: { publication_id: string; site: { domain?: string; domain_alias?: string }; settings: { sitewide_noindex?: boolean; trailing_slash?: TrailingSlashPolicy }; redirects?: Redirect[]; extensions?: ExtensionRuntimeSnapshot }) {
  await bundleBlockAssets(dist);
  await buildSearchIndexIfUsed(dist);
  if (publication.extensions?.installations?.length) await vendorExtensionAssets(dist, publication.extensions);
  if (!/^[a-f0-9]{64}$/.test(publication.publication_id)) throw new Error('Invalid publication identity');
  let headers = withGlobalHeaders(buildPagesHeaders(), {
    'X-Typeroll-Publication': publication.publication_id,
    ...(publication.settings.sitewide_noindex ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
  });
  headers += '\nhttps://:project.pages.dev/*\n  X-Robots-Tag: noindex, nofollow\n';
  headers += '\nhttps://:version.:project.pages.dev/*\n  X-Robots-Tag: noindex, nofollow\n';
  await fs.writeFile(path.join(dist, '_headers'), headers);
  const routes: string[] = [];
  async function walk(directory: string, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && relative.endsWith('.html') && relative !== '404.html') routes.push('/' + relative.replace(/index\.html$/, '').replace(/\.html$/, ''));
    }
  }
  await walk(dist);
  const marker = '.well-known/typeroll/publication.json';
  await fs.mkdir(path.dirname(path.join(dist, marker)), { recursive: true });
  await fs.writeFile(path.join(dist, marker), JSON.stringify({ id: publication.publication_id, paths: routes.length ? routes.sort() : ['/' + marker] }));
  const livePaths = new Set(routes);
  const safeRedirects = (publication.redirects ?? []).filter(rule => !pagesShadowedByRedirect(rule.from_path, rule.to_path, livePaths).length);
  const lines = expandRedirectsForTrailingSlashPolicy(safeRedirects, publication.settings.trailing_slash ?? 'always').map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
  const { domain, domain_alias: alias } = publication.site;
  if (domain && alias) {
    for (const hostname of [domain, alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    lines.unshift(`https://${alias}/* https://${domain}/:splat 301!`);
  }
  if (lines.length) await fs.writeFile(path.join(dist, '_redirects'), lines.join('\n') + '\n');
}
