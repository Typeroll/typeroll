# Claude Code connection reference

Use the maintained [Typeroll CMS connection guide](../packages/docs-site/src/content/docs/getting-started/mcp-server.mdx)
for credentials, remote Streamable HTTP and local stdio setup. The
[client compatibility page](../packages/docs-site/src/content/docs/getting-started/client-compatibility.mdx#claude-code)
links to Claude Code's own configuration instructions and records the boundary
between documented protocol support and actual Typeroll client verification.
This reference is not an end-to-end test report.

From MCP 0.45.23, the optional workspace is agent-neutral. For a local Claude
Code adapter:

```sh
npx @typeroll/mcp-server@0.45.23 init ./my-site --client claude
```

This creates project instructions and a private, ignored `.mcp.json` invoking
`workspace-mcp`. It does not store credentials or install recipes by default.
Record the Site, Organization and working Version in `typeroll.json` and inject
`TYPEROLL_API_KEY` privately. Existing edited files are preserved; update an
unchanged generated adapter with `--update --client claude`.

See the maintained [Agent workspace guide](../packages/docs-site/src/content/docs/getting-started/agent-workspace.mdx)
for the complete structure, doctor checks, optional recipes and compact discovery.
Hosted connections select the Site/Version per call and cannot read local files.
The hosted compact endpoint is `/api/mcp?tools=compact` on Core 0.2.27+.
