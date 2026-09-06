import fs from 'node:fs/promises';
import path from 'node:path';
import { bundleBlockAssets } from './source/bundle-blocks';
import { buildSearchIndexIfUsed } from './source/search-index';
import { buildPagesHeaders } from './source/pages-headers';

export async function postprocess(dist: string, publication: { site: { domain?: string; domain_alias?: string }; settings: { sitewide_noindex?: boolean } }) {
  await bundleBlockAssets(dist);
  await buildSearchIndexIfUsed(dist);
  let headers = buildPagesHeaders();
  if (publication.settings.sitewide_noindex) headers += '\n/*\n  X-Robots-Tag: noindex, nofollow\n';
  await fs.writeFile(path.join(dist, '_headers'), headers);
  const { domain, domain_alias: alias } = publication.site;
  if (domain && alias) {
    for (const hostname of [domain, alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    await fs.writeFile(path.join(dist, '_redirects'), `https://${alias}/* https://${domain}/:splat 301!\n`);
  }
}
