# Typeroll skills for Claude Code

Boilerplate skills that pair with [`@typeroll/mcp-server`](../packages/mcp-server/README.md).
Each one is a self-contained markdown file the agent reads when its
description matches the user's request. Recipes call MCP tools; the agent
adapts them to the specific job.

**The buffer model:** every content write is an unsaved per-doc draft until
explicitly saved (`commit_working_copy` or `save: true` on the write call).
Deploys ship saved content only — recipes that end in `trigger_deploy` must
save first.

## Installation

Copy whichever skills you need into your Claude Code skills directory.
Either:

```bash
# project-scoped (recommended)
mkdir -p .claude/skills
cp skills/*.md .claude/skills/

# or user-scoped (available in every project)
cp skills/*.md ~/.claude/skills/
```

Symlinks work too, so you can stay in sync with the upstream:

```bash
ln -s "$PWD/skills/tr-migrate-wp.md" ~/.claude/skills/
```

## The skills

### Bygga och designa

| File | When it triggers | What it does |
|---|---|---|
| `tr-new-site.md`       | "create a new site", "bootstrap a site for…"        | Settings → header/footer partials → homepage → inner pages → deploy. Full setup recipe. |
| `tr-brand.md`          | "create a brand", "choose colors", "design the look"| Palette recipes by mood, typography pairings, CSS variable setup, preview. |
| `tr-redesign-branch.md`| "redesign", "modernize", anything site-wide-design   | Branch-isolated work with preview links, merge when approved. |
| `tr-content-write.md`  | "write a page about…", "draft copy for…"            | Discovery first (settings + sample pages), then drafts in the site's voice, previews, iterates. |
| `tr-images.md`         | "make an image / hero / illustration", media uploads | Generates locally → signed upload URL → metadata patch → embed. |

### Funktioner

| File | When it triggers | What it does |
|---|---|---|
| `tr-blog.md` | "add a blog", "set up news" | Articles are Pages of a content type, sharing a native template and Page listing. |
| `tr-forms.md`             | "contact form", "add a form", "booking form"           | Form definition → embed HTML with signed token → inline JS feedback → deploy. |
| `tr-page-template.md` | Reusable Page templates: audio players, chapter lists, guest cards, image galleries — anything needing loops/nested data | Compose native blocks around `template_content_slot`; bind Page metadata, structured fields and references. |
| `tr-seo.md`               | "SEO", "meta descriptions", "structured data"          | Audit → fix titles/descriptions → OG images → JSON-LD → robots.txt → deploy. |

### Importera innehåll

| File | When it triggers | What it does |
|---|---|---|
| `tr-migrate-wp.md`     | "migrate from WordPress", a wp-json URL is mentioned     | Walks the WP REST, rebuilds each page in the target's design, transfers media, sets redirects, leaves everything as drafts for review. |
| `tr-migrate-multisite.md` | "multisite", "our .se/.de/.co.uk sites", migrating several sites at once | One site per domain; per-site URL inventory, design replicated via `.tcblocks`, path preservation, hreflang clusters, and a parity check against the deployed site before DNS moves. |
| `tr-migrate-astro.md`  | "migrate an Astro site", "import from src/content"       | Lifts Astro Content Collections (`src/content/*`) into Typeroll content types — zod schema → field list, frontmatter → field values, Markdown body → Page blocks. Translates standalone `src/pages/*` into Typeroll pages, maps `src/layouts` chunks into partials. |
| `tr-import-url.md`     | "import from Squarespace/Wix/Webflow", any non-WP URL    | Fetch → clean → adapt to target design → media transfer → draft pages → redirects → deploy. |

## Prerequisites for every skill

1. `@typeroll/mcp-server` configured in the agent’s MCP settings with a valid
   `TYPEROLL_API_KEY` and `TYPEROLL_API_URL`.
2. The agent has read `AGENTS.md` (ships with the MCP package — see
   `node_modules/@typeroll/mcp-server/AGENTS.md` after install, or
   reference it directly).

If those are missing, every skill will fail at the first MCP call with
"Missing bearer token" or "Invalid or revoked token".

## Authoring more

Skills are markdown files that the agent loads on demand. Each one
should include:

- A `description:` frontmatter explaining when to load it (agents use
  this to pick the right skill).
- A clear set of preconditions (what MCP tools must work, what state the
  agent needs to know).
- A numbered recipe with concrete tool calls.
- A "Pitfalls" section that captures lessons learned across customer
  jobs.

Keep them under ~150 lines so the agent reads them quickly. If a skill
balloons, split it.
