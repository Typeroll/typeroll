// Tests for the skill-discovery tools (read_guide / list_skills / read_skill).
//
// The tools serve EMBEDDED content (bundled-content.ts) so they survive being
// bundled into the hosted portal. A drift guard at the bottom asserts that
// embedded copy still matches the physical source files — so editing a skill
// or AGENTS.md without re-running `npm run gen` fails CI rather than silently
// shipping stale content.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  skillTools,
  parseSkillFrontmatter,
  listBundledSkills,
  readBundledSkill,
  readPackageDoc,
} from '../src/tools/skills.js';
import { BUNDLED_SKILLS, BUNDLED_DOCS } from '../src/bundled-content.js';
import { TyperollClient } from '../src/client.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(PKG_ROOT, 'skills');

// Skill tools never touch the client; a throwaway instance satisfies the deps.
const deps = {
  client: new TyperollClient({ baseUrl: 'https://unused.test', apiKey: 'typeroll_live_x_y' }),
  siteId: '',
};

function find(name: string) {
  const t = skillTools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

async function physicalSkillNames(): Promise<string[]> {
  const entries = await fs.readdir(SKILLS_DIR);
  return entries
    .filter((f) => f.startsWith('tr-') && f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

describe('read_guide tool', () => {
  it('returns the bundled AGENTS.md by default', async () => {
    const result = await find('read_guide').handler({} as never, deps);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('AGENTS.md — Working on a Typeroll site');
  });

  it('returns the README when doc=readme', async () => {
    const result = await find('read_guide').handler({ doc: 'readme' } as never, deps);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('@typeroll/mcp-server');
  });

  it('rejects an unknown guide key', () => {
    expect(() => readPackageDoc('secrets')).toThrow(/unknown guide/i);
  });

  it('is flagged noSite so the hosted transport skips site_id', () => {
    expect(find('read_guide').noSite).toBe(true);
  });
});

describe('tr-responsive skill ships', () => {
  it('is bundled and surfaced by list_skills with a description', () => {
    const resp = listBundledSkills().find((s) => s.name === 'tr-responsive');
    expect(resp).toBeDefined();
    expect(resp!.description.length).toBeGreaterThan(0);
    const md = readBundledSkill('tr-responsive');
    expect(md).toContain('set_block_responsive');
    expect(md).toContain('responsive_css');
  });
});

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from YAML frontmatter', () => {
    const md = '---\nname: tr-demo\ndescription: Do a demo thing.\n---\n\n# Body\n';
    expect(parseSkillFrontmatter(md, 'fallback')).toEqual({
      name: 'tr-demo',
      description: 'Do a demo thing.',
    });
  });

  it('falls back to the provided name when name: is missing', () => {
    const md = '---\ndescription: No name here.\n---\n';
    expect(parseSkillFrontmatter(md, 'tr-fallback')).toEqual({
      name: 'tr-fallback',
      description: 'No name here.',
    });
  });

  it('returns an empty description when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a heading\n', 'tr-x')).toEqual({
      name: 'tr-x',
      description: '',
    });
  });
});

describe('listBundledSkills', () => {
  it('returns every bundled tr-*.md with a name + description', () => {
    const skills = listBundledSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.name).toMatch(/^tr-[a-z0-9-]+$/);
      expect(s.description.length).toBeGreaterThan(0);
    }
    const names = skills.map((s) => s.name);
    expect(names).toContain('tr-new-site');
    expect(names).toContain('tr-migrate-wp');
  });
});

describe('list_skills tool', () => {
  it('returns the full bundled set with a count', async () => {
    const result = await find('list_skills').handler({} as never, deps);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text) as {
      skills: Array<{ name: string; description: string }>;
      count: number;
    };
    expect(payload.count).toBe(payload.skills.length);
    expect(payload.count).toBe(Object.keys(BUNDLED_SKILLS).length);
  });

  it('is flagged noSite so the hosted transport skips site_id', () => {
    expect(find('list_skills').noSite).toBe(true);
    expect(find('read_skill').noSite).toBe(true);
  });
});

describe('read_skill tool', () => {
  it('returns the markdown for a real skill', async () => {
    const result = await find('read_skill').handler({ name: 'tr-new-site' } as never, deps);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('tr-new-site');
  });

  it('rejects a non-existent skill with a helpful message', async () => {
    const result = await find('read_skill').handler({ name: 'tr-nope-nope' } as never, deps);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('rejects names that do not match the tr- pattern (no path traversal)', async () => {
    for (const bad of ['README', '../secret', 'tr-foo/../bar', '/etc/passwd', 'tr-foo ']) {
      const result = await find('read_skill').handler({ name: bad } as never, deps);
      expect(result.isError).toBe(true);
    }
  });
});

// The guard that makes embedding safe: the committed bundled-content.ts must
// match the physical source. If this fails, run `npm run gen`.
describe('embedded content is in sync with source files', () => {
  it('every physical skill matches its embedded copy', async () => {
    const names = await physicalSkillNames();
    expect(Object.keys(BUNDLED_SKILLS).sort()).toEqual(names);
    for (const name of names) {
      const onDisk = await fs.readFile(path.join(SKILLS_DIR, `${name}.md`), 'utf8');
      expect(BUNDLED_SKILLS[name]).toBe(onDisk);
    }
  });

  it('AGENTS.md + README match the embedded docs', async () => {
    expect(BUNDLED_DOCS.agents).toBe(await fs.readFile(path.join(PKG_ROOT, 'AGENTS.md'), 'utf8'));
    expect(BUNDLED_DOCS.readme).toBe(await fs.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8'));
  });
});
