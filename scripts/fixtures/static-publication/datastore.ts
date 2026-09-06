import fs from 'node:fs/promises';
import path from 'node:path';

export interface ReadStore {
  getDoc<T = unknown>(p: string): Promise<T | null>;
  listDocs<T = unknown>(p: string): Promise<Array<T & { id: string }>>;
}

export function getStore(): ReadStore {
  const root = process.env.TYPEROLL_FIXTURES_DIR;
  if (!root) throw new Error('A frozen publication fixture directory is required');
  const locate = (relative: string) => {
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid publication path');
    return target;
  };
  return {
    async getDoc<T>(relative: string): Promise<T | null> {
      try { return JSON.parse(await fs.readFile(`${locate(relative)}.json`, 'utf8')) as T; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async listDocs<T>(relative: string): Promise<Array<T & { id: string }>> {
      const directory = locate(relative);
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const result = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && entry.name.endsWith('.json')) result.push({ id: entry.name.slice(0, -5), ...JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8')) });
      }
      return result;
    },
  };
}
