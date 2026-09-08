import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStaticPublicationProject } from './lib/static-publication.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-publication-template-'));
try {
  const destination = path.join(temporary, 'project');
  await createStaticPublicationProject({ format: 'typeroll-static-publication', format_version: 1, pages: [], partials: [], media: [] }, destination);
  const result = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: destination, stdio: 'inherit', timeout: 180_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_cache: process.env.npm_config_cache },
  });
  if (result.error || result.status !== 0) throw new Error('Could not freeze the publication dependency lock');
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'publication.json') continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) files[relative] = await fs.readFile(path.join(directory, entry.name), 'utf8');
      else throw new Error('Publication source contains a symlink');
    }
  }
  await walk(destination);
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  await fs.writeFile(path.join(root, 'publication-template.json'), JSON.stringify({ format: 'typeroll-publication-template', version, files }));
  console.log(`Frozen publication build template ${version}: ${Object.keys(files).length} source files`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
