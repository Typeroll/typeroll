# Connecting Claude Code to Typeroll in production

End-to-end recipe for an agency or power user to wire `@typeroll/mcp-server`
into their Claude Code, against the production portal at
`https://app.typeroll.com`.

> Looking for Claude Desktop / claude.ai instead of Claude Code? Add a
> Custom Connector pointing at `https://app.typeroll.com/api/mcp` —
> no CLI, no Node install needed. See
> [packages/docs-site → getting-started/mcp-server](../packages/docs-site/src/content/docs/getting-started/mcp-server.mdx).

## 1. Create an API key

The key is the only credential Claude Code needs — revocable, no other
secrets required. Two scope choices:

- **Org-scoped** (recommended for agencies): `/app/settings/api-keys` →
  **New key**. One credential covers every site in your org *and* every
  site shared into your org. For stdio use, pair it with
  `TYPEROLL_SITE_ID` to pick which site Claude Code targets per
  install.
- **Site-scoped** (single-site blast radius): open a site → Settings →
  **API keys** (under "External access") → **New key**. Useful for
  handing a customer a credential they can revoke without affecting
  the rest of the org's keys.

Copy the full `typeroll_live_…` token shown once. **You can't view it
again** — store it somewhere only you can access. The portal lists
active keys with name + last-used metadata; click **Revoke** any time
to kill access immediately.

## 2. Wire it into Claude Code

Open your `~/.claude.json` (or your project's `.claude/config.json`)
and add a `mcpServers.typeroll` entry:

```json
{
  "mcpServers": {
    "typeroll": {
      "command": "npx",
      "args": ["-y", "@typeroll/mcp-server"],
      "env": {
        "TYPEROLL_API_URL": "https://app.typeroll.com",
        "TYPEROLL_API_KEY": "typeroll_live_REPLACE_WITH_YOUR_KEY"
      }
    }
  }
}
```

For a **self-hosted** Typeroll, change `TYPEROLL_API_URL` to your
portal's URL (e.g. `https://cms.example.com`).

The first `npx` call downloads the package; subsequent sessions reuse the
cached install (or pin to a version with `args: ["-y", "@typeroll/mcp-server@1.x"]`).

## 3. Optional: bootstrap the project (`init`)

The package ships a set of battle-tested skill prompts — among them:

- `tr-new-site` — build a complete site from a brief
- `tr-brand` — palette, typography, section design, site icons
- `tr-forms` — create + embed working forms (signed token, no-JS flow)
- `tr-seo` — titles, descriptions, OG, structured data
- `tr-imagegen` — local AI image-generation lab (Gemini/OpenAI/Higgsfield) feeding the media library
- `tr-blog`, `tr-collection-template`, `tr-page-template` — collections + templates
- `tr-migrate-wp`, `tr-migrate-astro`, `tr-import-url` — migrations and imports
- `tr-migrate-multisite` — a whole family of sites at once (WP multisite, or
  per-country domains): inventory, shared design, hreflang, pre-cutover parity check
- `tr-content-write` — draft new pages in the site's voice
- `tr-images` — upload, generate variants, fill alt-text
- `tr-directory` — directory sites from scraped / external data
- `tr-redesign-branch` — branch-isolated redesign flows

The fastest way to scaffold a local project folder with them is the
`init` subcommand. From the directory you want to work in:

```bash
npx @typeroll/mcp-server init
```

That copies the skills into `.claude/skills/`, writes (or merges) a
`.mcp.json` with a `typeroll` server entry (fill in `TYPEROLL_API_KEY`
and `TYPEROLL_SITE_ID`), and drops an `AGENTS.md` pointer plus the
`.env.example` + `images/lab/.gitignore` the imagegen lab expects. It's
**idempotent** — rerunning never clobbers your edits, and existing
`.mcp.json` values are preserved; pass `--force` to overwrite. To target
another folder: `npx @typeroll/mcp-server init path/to/dir`.

> Just want the skills, no config? `npx @typeroll/mcp-server
> install-skills .claude/skills` copies only the `tr-*.md` files (add
> `--force` to overwrite, or point it at `~/.claude/skills` for
> user scope).

You don't strictly need local skill files at all: the running MCP server
now advertises the same playbook through two tools — **`list_skills`**
(names + descriptions, call it early when the user wants to build /
migrate / redesign a site) and **`read_skill name=tr-new-site`** (the
full markdown). These work identically on the hosted connector and over
stdio, so an agent discovers the platform's recipes at connection time
even without any files copied locally.

## 4. Verify the connection

In a fresh Claude Code conversation, ask the agent:

> "Connect to Typeroll, confirm the key works, and tell me what
> URLs the site is reachable at."

The agent should call `get_site` and report:

```
Site: <name>
ID: <site-id>
Slug: <slug or null>
URLs:
  production: <real-domain or null>
  fallback:   https://<slug>.sites.typeroll.app   (or null in self-host)
  preview_base: https://app.typeroll.com/preview/<site-id>
```

If `get_site` returns 401, the key is wrong or revoked.

## 5. First real task

Pick something safe to verify the write path:

> "Read the home page, add a `<!-- agent test -->` HTML comment at the
> very end of the body, save it as a draft (don't publish), and give
> me a preview link so I can see it landed."

The agent should:
1. `read_page page_id=home`
2. `update_page page_id=home patch={ html_content: "…<!-- agent test -->" }`
3. `get_preview_link page_id=home`

You click the preview URL, confirm the comment is at the bottom, then
tell the agent to revert (`update_page` without the comment) — done.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing bearer token` | `TYPEROLL_API_KEY` env var not picked up. Restart Claude Code after editing `.claude.json`. |
| `Invalid or revoked token` | Key was revoked, or you copied it wrong. Check the portal's API keys page. |
| `Rate limit exceeded` + `Retry-After` | 600 reads/min or 60 writes/min was exceeded. Wait the indicated seconds. |
| `get_preview_link → 503` | `PREVIEW_HMAC_SECRET` isn't set on the portal (production has it; self-hosted needs to add it). |
| `trigger_deploy → "no deploy URL available"` | Cloudflare credentials aren't configured on the portal. Deploys still queue and run — the URL just isn't returned. |
| Agent doesn't see the MCP at all | Verify the `mcpServers` entry is in the right config file. Run `which npx` — `command: "npx"` resolves through your shell. |

## Security considerations

- **Keys are site-scoped.** A key from site A cannot read or write site B
  in the same org. Don't share a key across multiple agents working on
  different sites — give each their own.
- **Treat keys like passwords.** They're written into Claude Code's
  config file in plaintext (Anthropic's MCP spec doesn't yet require
  encryption-at-rest for MCP env). Don't commit `.claude.json` to git.
- **Revocation is instant.** When an agency engagement ends, revoke the
  key in the portal. Existing in-flight requests complete; the next one
  fails with 401.
- **Audit log.** Every write call is logged with the key prefix. The
  customer can see "this key wrote to /pages/foo at 14:32" — useful
  for forensics if a key leaks.

## Versioning + updates

The MCP server is published to npm as `@typeroll/mcp-server`. The
`npx -y` flag in the config above always pulls the latest. Pin a major
version (`@typeroll/mcp-server@1.x`) if you want stability across
sessions.

The REST API behind the MCP is versioned under `/api/v1/...`. New
features land additively; breaking changes (rare) would move to
`/api/v2/...` with a deprecation window for v1.
