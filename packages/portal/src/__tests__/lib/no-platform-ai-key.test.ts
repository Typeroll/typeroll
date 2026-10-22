// There is no platform-level AI key: AI keys belong to organizations
// (lib/ai/organization-ai.ts). Guard against a server-wide fallback coming
// back in portal or shared runtime source, the e2e server or the examples.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const portal = fileURLToPath(new URL('../../../', import.meta.url));
const repo = join(portal, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === '__tests__' || entry === 'node_modules') return [];
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|astro|mjs|js)$/.test(entry) ? [full] : [];
  });
}

describe('no platform AI key', () => {
  it('no runtime source, e2e server or example environment reads ANTHROPIC_API_KEY', () => {
    const files = [
      ...walk(join(portal, 'src')),
      ...walk(join(repo, 'packages', 'shared', 'src')),
      join(portal, 'playwright.config.ts'),
      join(portal, '.env.example'),
      join(repo, '.env.self-host.example'),
      join(repo, 'compose.yaml'),
      join(repo, 'Dockerfile'),
    ];
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('ANTHROPIC_API_KEY'));
    expect(offenders).toEqual([]);
  });
});
