import fs from 'node:fs/promises';
import path from 'node:path';
import { bundleBlockAssets } from './source/bundle-blocks';
import { buildSearchIndexIfUsed } from './source/search-index';
import { applyQueryRedirects, pagesRedirectsFile, pagesShadowedByRedirect, pageRobots } from '@typeroll/shared';
import type { Redirect, TrailingSlashPolicy } from '@typeroll/shared';
import { buildPagesHeaders, withGlobalHeaders } from './source/pages-headers';
import { vendorExtensionAssets } from './source/extensions/assets';
import { vendorThemeFonts, writeFrozenThemeFonts, type FrozenThemeFonts } from './source/extensions/theme-fonts';
import type { ExtensionRuntimeSnapshot } from '@typeroll/shared';

export async function postprocess(dist: string, publication: { publication_id: string; previous_website_hosts?: string[]; robots_blocked?: boolean; site: { domain?: string; domain_alias?: string }; settings: { sitewide_noindex?: boolean; sitewide_nofollow?: boolean; trailing_slash?: TrailingSlashPolicy; fonts?: { heading?: string; body?: string; mono?: string; delivery?: 'self_hosted' | 'google' } }; redirects?: Redirect[]; extensions?: ExtensionRuntimeSnapshot; theme_fonts?: FrozenThemeFonts }) {
  await bundleBlockAssets(dist);
  await buildSearchIndexIfUsed(dist);
  if (publication.extensions?.installations?.length) await vendorExtensionAssets(dist, publication.extensions);
  // Typeroll froze the font files with the publication; older snapshots and
  // local harnesses copy them here. A self-hosted site never ships without them.
  if (publication.theme_fonts) await writeFrozenThemeFonts(dist, publication.theme_fonts);
  else {
    const fonts = await vendorThemeFonts(dist, publication.settings.fonts, fetch, { cacheDir: path.join(dist, '..', '.publication-fonts') });
    if (fonts.error) throw new Error(`theme_fonts_unavailable: ${fonts.error}`);
  }
  if (!/^[a-f0-9]{64}$/.test(publication.publication_id)) throw new Error('Invalid publication identity');
  let headers = withGlobalHeaders(buildPagesHeaders(), {
    'X-Typeroll-Publication': publication.publication_id,
    ...((publication.settings.sitewide_noindex || publication.settings.sitewide_nofollow || publication.robots_blocked) ? { 'X-Robots-Tag': pageRobots({}, publication.settings, publication.robots_blocked) } : {}),
  });
  headers += '\nhttps://:project.pages.dev/*\n  X-Robots-Tag: noindex, nofollow\n';
  headers += '\nhttps://:version.:project.pages.dev/*\n  X-Robots-Tag: noindex, nofollow\n';
  for (const host of publication.previous_website_hosts ?? []) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host === publication.site.domain) throw new Error('Invalid previous website host');
    headers += `\nhttps://${host}/*\n  X-Robots-Tag: noindex, nofollow\n`;
  }
  await fs.writeFile(path.join(dist, '_headers'), headers);
  const routes: string[] = [];
  async function walk(directory: string, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && relative.endsWith('.html') && relative !== '404.html' && !relative.endsWith('/404.html')) routes.push('/' + relative.replace(/index\.html$/, '').replace(/\.html$/, ''));
    }
  }
  await walk(dist);
  const marker = '.well-known/typeroll/publication.json';
  await fs.mkdir(path.dirname(path.join(dist, marker)), { recursive: true });
  await fs.writeFile(path.join(dist, marker), JSON.stringify({ id: publication.publication_id, paths: routes.length ? routes.sort() : ['/' + marker] }));
  const livePaths = new Set(routes);
  const safeRedirects = (publication.redirects ?? []).filter(rule => !pagesShadowedByRedirect(rule.from_path, rule.to_path, livePaths).length);
  const redirects = pagesRedirectsFile(safeRedirects, publication.settings, publication.site);
  if (redirects) await fs.writeFile(path.join(dist, '_redirects'), redirects);
  await applyQueryRedirects(safeRedirects, {
    exists: relative => fs.access(path.join(dist, relative)).then(() => true, () => false),
    read: relative => fs.readFile(path.join(dist, relative), 'utf8'),
    write: (relative, text) => fs.writeFile(path.join(dist, relative), text),
  });
}
