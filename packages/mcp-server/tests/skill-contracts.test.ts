// Guards that keep the bundled skills honest about the platform:
//
// 1. Every MCP tool a skill tells an agent to call exists on the server.
// 2. tr-seo's "What Typeroll handles automatically" list names every site
//    file the renderer writes and every JSON-LD type it emits on its own, so
//    agents never hand-build what a publication already produces.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../src/server.js';
import { TyperollClient } from '../src/client.js';
import { BUNDLED_SKILLS } from '../src/bundled-content.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const client = new TyperollClient({ baseUrl: 'https://unused.test', apiKey: 'typeroll_live_x_y' });

function registeredToolNames(): Set<string> {
  const names = new Set<string>(['select_site']);
  for (const toolMode of [undefined, 'compact'] as const) {
    const server = buildServer({ client, fixedSiteId: 'site1', ...(toolMode ? { toolMode } : {}) });
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    for (const name of Object.keys(registry)) names.add(name);
  }
  return names;
}

// Identifiers that start like a tool call but are something else: fields,
// workflow types and other systems' names. Keep each entry explained.
const NOT_TOOLS = new Set<string>([
  'duplicate_fonts', 'duplicate_titles', 'duplicate_descriptions', // read_site_readiness item ids
  'check_source', // verify_migration_urls argument
  'launch_ready', // get_migration_launch_report field
  'start_date', // add_event_schema argument
  'list_style', // Table of contents block field
  'upload_url', // create_upload_url response field
]);

// Tool names start with a verb; fields such as `default_og_image` do not.
const TOOL_SHAPE = /\b((?:get|list|read|create|update|delete|add|set|check|verify|trigger|upload|import|export|batch|commit|discard|apply|approve|prepare|retry|revoke|select|start|merge|reset|restore|find|generate|insert|save|search|replace|remove|move|duplicate|make|detach|preview|poll|activate|connect|configure|decide|diagnose|lint|purge|finalize|archive|share|install|uninstall|launch|publish|record|repair|resolve|suggest|send|override|cancel|change|clone|guide|onboard|migrate|pair|recover|describe|call|validate)_[a-z0-9_]+)\b/g;

describe('skills reference only real MCP tools', () => {
  it('every tool-shaped identifier in a bundled skill is a registered tool', () => {
    const tools = registeredToolNames();
    const unknown: string[] = [];
    for (const [skill, markdown] of Object.entries(BUNDLED_SKILLS)) {
      for (const match of markdown.matchAll(TOOL_SHAPE)) {
        const name = match[1];
        if (tools.has(name) || NOT_TOOLS.has(name)) continue;
        unknown.push(`${skill}: ${name}`);
      }
    }
    expect([...new Set(unknown)].sort()).toEqual([]);
  });
});

async function renderedSiteFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await renderedSiteFiles(full)));
    else {
      // Astro endpoints are named after the file they write: `robots.txt.ts`.
      // A dynamic segment such as `[n]` is written as `<n>` in the skill.
      const output = entry.name.match(/^(.+\.(?:xml|txt|md))\.ts$/)?.[1];
      if (output) out.push(output.replace(/\[(\w+)\]/g, '<$1>'));
    }
  }
  return out;
}

// JSON-LD types that only appear nested inside another node.
const NESTED_TYPES = new Set(['PostalAddress', 'WebPage', 'Person', 'ImageObject']);

describe('tr-seo lists what the platform produces automatically', () => {
  const skill = BUNDLED_SKILLS['tr-seo'];
  const automatic = skill.slice(
    skill.indexOf('## What Typeroll handles automatically'),
    skill.indexOf('## Recipe'),
  );

  it('has an automatic-output section', () => {
    expect(automatic.length).toBeGreaterThan(200);
  });

  it('names every site file the renderer writes', async () => {
    const files = await renderedSiteFiles(path.join(REPO_ROOT, 'packages/site-template/src/pages'));
    expect(files).toEqual(expect.arrayContaining(['robots.txt', 'sitemap.xml', 'llms.txt']));
    for (const file of files) expect(automatic, `tr-seo should mention ${file}`).toContain(file);
  });

  it('names every top-level JSON-LD type the head emits', async () => {
    const head = await fs.readFile(path.join(REPO_ROOT, 'packages/site-template/src/components/SEOHead.astro'), 'utf8');
    const types = new Set([...head.matchAll(/'@type':\s*'([A-Za-z]+)'/g)].map(match => match[1]));
    expect(types.size).toBeGreaterThan(0);
    for (const type of types) {
      if (NESTED_TYPES.has(type)) continue;
      expect(automatic, `tr-seo should mention ${type}`).toContain(type);
    }
  });

  it('names the head tags and settings agents must not duplicate', () => {
    for (const output of ['canonical', 'og:image', 'hreflang', 'BreadcrumbList', 'FAQPage', 'ai_crawler_policy', 'Content-Signal', 'index.md']) {
      expect(automatic).toContain(output);
    }
  });

  it('starts from the readiness report', () => {
    expect(skill).toContain('read_site_readiness');
  });
});

describe('launch steps', () => {
  for (const skill of ['tr-new-site', 'tr-migrate-wp', 'tr-migrate-astro', 'tr-migrate-multisite', 'tr-redesign-branch']) {
    it(`${skill} asks for launch basics and ends with a required launch check`, () => {
      const markdown = BUNDLED_SKILLS[skill];
      expect(markdown).toMatch(/Launch basics/);
      expect(markdown).toContain('default_og_image');
      expect(markdown).toContain('same_as');
      expect(markdown).toMatch(/Launch[^\n]*\(required\)/);
      expect(markdown).toContain('read_site_readiness');
      expect(markdown).toMatch(/Never\s+generate a title card/);
    });
  }
});

describe('starter templates plan pages and launch', () => {
  it('asks for launch basics and a page plan before design', async () => {
    const { workspaceTemplates } = await import('../src/workspace.js');
    expect(workspaceTemplates['brief/seo.md']).toContain('## Launch basics');
    expect(workspaceTemplates['brief/seo.md']).toContain('default_og_image');
    expect(workspaceTemplates['brief/content-model.md']).toContain('## Page plan');
    expect(workspaceTemplates['workflows/interview.md']).toContain('Which pages does the business need?');
    expect(workspaceTemplates['workflows/new-site.md']).toContain('page plan');
  });

  it('runs the readiness report at launch and keeps its result in qa/', async () => {
    const { workspaceTemplates } = await import('../src/workspace.js');
    const checklist = workspaceTemplates['qa/checklist.md'];
    expect(checklist).toContain('## Launch');
    expect(checklist).toContain('read_site_readiness');
    expect(checklist).toContain('qa/launch-readiness.md');
  });
});
