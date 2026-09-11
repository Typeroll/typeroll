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
cpSync(path.resolve(root, '../../temp/docs-subdirectory'), path.join(output, 'main-host/docs'), { recursive: true });
writeFileSync(path.join(output, 'main-host/docs/release.json'), JSON.stringify({ source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }) + '\n');
const sitemap = readFileSync(path.join(output, 'main-host/docs/sitemap-0.xml'), 'utf8');
const routes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, destination]) => ({ destination }));
writeFileSync(path.join(output, 'routes.json'), JSON.stringify(routes, null, 2) + '\n');
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

The release workflow deploys main-host/ as Cloudflare static assets and verifies
all destinations in routes.json. There is no old-domain deployment or redirect
artifact. Never publish this whole preparation directory as a website.
`);
console.log(`Prepared ${routes.length} public routes and static /docs overlay at ${output}`);
