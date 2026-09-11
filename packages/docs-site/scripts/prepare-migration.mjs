#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['scripts/build-subdirectory.mjs'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const output = path.resolve(root, '../../temp/docs-migration');
rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, 'main-host/docs'), { recursive: true });
mkdirSync(path.join(output, 'old-docs-host'), { recursive: true });
cpSync(path.resolve(root, '../../temp/docs-subdirectory'), path.join(output, 'main-host/docs'), { recursive: true });
writeFileSync(path.join(output, 'old-docs-host/_redirects'), '/* https://typeroll.com/docs/:splat 301\n');
writeFileSync(path.join(output, 'old-docs-host/index.html'), '<!doctype html><html lang="en"><title>Typeroll CMS documentation has moved</title><a href="https://typeroll.com/docs/">Open the documentation</a></html>\n');
writeFileSync(path.join(output, 'main-host/docs/release.json'), JSON.stringify({ source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }) + '\n');
const sitemap = readFileSync(path.join(output, 'main-host/docs/sitemap-0.xml'), 'utf8');
const routes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, destination]) => ({
  source: destination.replace('https://typeroll.com/docs/', 'https://docs.typeroll.com/'),
  destination,
  status: 301,
}));
writeFileSync(path.join(output, 'redirect-checklist.json'), JSON.stringify(routes, null, 2) + '\n');
writeFileSync(path.join(output, 'root-robots-addition.txt'), 'Sitemap: https://typeroll.com/docs/sitemap-index.xml\n');
writeFileSync(path.join(output, 'root-llms-addition.txt'), '- [Typeroll CMS documentation](https://typeroll.com/docs/llms.txt): editing, AI agents, publishing and self-hosting\n');
writeFileSync(path.join(output, 'README.txt'), `Prepared locally. Nothing has been deployed.

main-host/docs/ contains the complete static documentation. Mount it at /docs/
on the existing website host. This is an overlay, not a replacement website.
Serve /docs as a redirect to /docs/. Preserve the rest of the main website.
Merge root-robots-addition.txt into the real root robots.txt; /docs/robots.txt
alone cannot govern crawling. Merge root-llms-addition.txt into root llms.txt.
Use docs/404.html with HTTP 404 for missing documentation paths; do not return
the marketing homepage or documentation index with HTTP 200.

Only after the destination works publicly, deploy old-docs-host/ to the old
Cloudflare Pages project. Its _redirects rule permanently redirects each old
path to the same path below /docs/. Verify query strings and all routes in
redirect-checklist.json against real responses. Keep the old project and TLS.

The release workflow deploys main-host/ as Cloudflare static assets, verifies
the live /docs destination, then deploys old-docs-host/ to the previous Pages
project. Preserve that order. Save previous deployments for rollback. Never
publish this whole migration directory as a website.
`);
console.log(`Prepared ${routes.length} page redirects and static /docs overlay at ${output}`);
