# Claude Code connection reference

Use the maintained [Typeroll CMS connection guide](../packages/docs-site/src/content/docs/getting-started/mcp-server.mdx)
for credentials, remote Streamable HTTP and local stdio setup. The
[client compatibility page](../packages/docs-site/src/content/docs/getting-started/client-compatibility.mdx#claude-code)
links to Claude Code's own configuration instructions and records the boundary
between documented protocol support and actual Typeroll client verification.
This reference is not an end-to-end test report.

For the optional Claude Code project scaffold:

```sh
npx @typeroll/mcp-server init
```

This creates or merges `.mcp.json`, installs recipes in `.claude/skills/`, and
adds the project's agent briefing. Configure credentials privately. The scaffold
is client-specific; other agents can connect through MCP without generating
these files and retrieve the same guidance through `read_guide`, `list_skills`
and `read_skill`.

For a stdio connection with several accessible Sites, set `TYPEROLL_SITE_ID`.
The running process binds to one Site. Hosted multi-site connections can select
a Site per tool call. Use `/api/mcp` on both hosted and self-hosted portals.
