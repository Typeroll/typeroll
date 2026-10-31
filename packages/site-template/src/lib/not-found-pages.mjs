import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'data-tr-not-found';

/**
 * Astro writes a language section's 404 page to `<home_path>404/index.html`.
 * Hosts that serve the nearest 404 page look for `<home_path>404.html`, so
 * move each one there. Only files the NotFound component rendered move; a
 * content page that happens to live at …/404/ stays where it is.
 */
export async function moveSectionNotFoundPages(dist) {
  const moved = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === '404' && directory !== dist) {
        const index = path.join(child, 'index.html');
        const html = await fs.readFile(index, 'utf8').catch(() => null);
        if (html?.includes(MARKER)) {
          await fs.writeFile(path.join(directory, '404.html'), html);
          await fs.rm(index);
          if (!(await fs.readdir(child)).length) await fs.rmdir(child);
          moved.push(path.relative(dist, path.join(directory, '404.html')).split(path.sep).join('/'));
          continue;
        }
      }
      await walk(child);
    }
  }
  await walk(dist);
  return moved.sort();
}

export function notFoundPages() {
  return {
    name: 'typeroll-not-found-pages',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        await moveSectionNotFoundPages(dir instanceof URL ? fileURLToPath(dir) : String(dir));
      },
    },
  };
}
