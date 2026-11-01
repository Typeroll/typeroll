import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Options for starlight-llms-txt: what agents read first in llms.txt, what the
// abridged llms-small.txt leaves out, and the focused sets listed beside it.

/** Byte budget for llms-small.txt, checked after every build. */
export const SMALL_BUDGET = 220_000;

/**
 * The pages in llms-small.txt: what Typeroll is, how to connect an agent, the
 * core editing and publishing workflows, launch and SEO. Everything else, such
 * as the full references, provider troubleshooting and the skill recipes, stays
 * in llms-full.txt, the focused sets and the per-page text files. A new page is
 * left out until it is added here, so the abridged file stays within budget.
 */
export const SMALL_PAGES = [
  'index',
  'getting-started/introduction',
  'getting-started/first-site',
  'getting-started/mcp-server',
  'getting-started/connect-your-agent',
  'getting-started/self-hosting-quickstart',
  'guides/build-with-claude-code',
  'guides/the-editor',
  'guides/site-structure',
  'guides/block-library',
  'guides/page-templates',
  'guides/multilingual-sites',
  'guides/typeroll-cloud',
  'guides/cloud-trial',
  'guides/ai-connections',
  'guides/publication-validation',
  'guides/launch-checklist',
  'guides/seo',
  'guides/migration-approach',
  'skills/overview',
];

const contentDir = fileURLToPath(new URL('../src/content/docs/', import.meta.url));

/** Every other docs page, as starlight-llms-txt `exclude` ids. */
export function smallExclude(directory = contentDir) {
  const keep = new Set(SMALL_PAGES);
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter(file => /\.mdx?$/.test(file))
    .map(file => file.replace(/\\/g, '/').replace(/\.mdx?$/, ''))
    .filter(id => !keep.has(id))
    .sort();
}

export const CUSTOM_SETS = [
  { label: 'Skills', paths: ['skills/**'], description: 'every step-by-step recipe the MCP server gives agents through read_skill' },
  { label: 'MCP tool reference', paths: ['tools/**'], description: 'parameters and behaviour of every MCP tool and the matching REST routes' },
  { label: 'Publishing and domains', paths: ['publishing/**', 'guides/customer-publishing', 'guides/*-troubleshooting', 'guides/custom-domain', 'guides/publication-validation'], description: 'Cloudflare and GitHub connections, builds, domains and troubleshooting' },
  { label: 'Migration', paths: ['guides/migration-approach', 'guides/wordpress-migration', 'guides/migrate-*', 'guides/migration-seo-checklist', 'tools/migration-urls', 'skills/tr-migrat*', 'skills/tr-import-url'], description: 'moving a WordPress, Squarespace, Wix, Webflow or Astro site to Typeroll without losing URLs' },
  { label: 'Extensions', paths: ['extensions/**'], description: 'building and operating Extensions' },
];

export function llmsOptions(publicUrl) {
  const docs = path => new URL(path, publicUrl).href;
  return {
    projectName: 'Typeroll CMS',
    description: 'Typeroll is an open-source CMS for static websites. People edit in a visual editor, AI agents work through an MCP server or the REST API, and each publication compiles the content into a static Astro site hosted in the customer\'s own Cloudflare or GitHub account. Available as Typeroll Cloud or self-hosted.',
    details: [
      '- **MCP server for Typeroll Cloud:** `https://app.typeroll.com/api/mcp` (Streamable HTTP, sign in with OAuth). Self-hosted portals use `https://<portal-host>/api/mcp`.',
      '- **Local MCP process:** `npx -y @typeroll/mcp-server` with `TYPEROLL_API_URL` and `TYPEROLL_API_KEY`.',
      `- **Connect a client:** [setup for Claude, Claude Code, Cursor, VS Code, Codex and ChatGPT](${docs('getting-started/connect-your-agent/')}).`,
      `- **Start here:** [Introduction](${docs('getting-started/introduction/')}), [Your first site](${docs('getting-started/first-site/')}), [Edit pages](${docs('guides/the-editor/')}).`,
      `- **Recipes:** the MCP server serves step-by-step skills through \`list_skills\` and \`read_skill\`; [all skills](${docs('skills/overview/')}).`,
      '- **Reading tips:** every page below has a plain-text version, listed with its description. Load `llms-small.txt` for an overview, a focused set for one area, or `llms-full.txt` for everything.',
    ].join('\n'),
    minify: { whitespace: false },
    exclude: smallExclude(),
    customSets: CUSTOM_SETS,
    customSelectors: { all: ['.sl-anchor-link'] },
  };
}
