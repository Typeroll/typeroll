# Typeroll CMS plugin packages

Build two reviewable packages from the canonical MCP recipe:

```sh
node packages/mcp-server/scripts/build-plugins.mjs
# A self-hosted deployment uses its own endpoint:
node packages/mcp-server/scripts/build-plugins.mjs /tmp/typeroll-plugins https://cms.example.com/api/mcp
```

Output: unpacked `openai/`, `claude/` and one ZIP for each, under
`temp/agent-plugins/` by default. No customer data, private Apps guides, keys,
hooks or local processes are included. The single bundled editing recipe
loads deeper recipes on demand through MCP. Personal connections default to
compact tool discovery. The generator takes its version from the MCP package.

The portable OpenAI manifest and Claude compatibility manifest follow the
[OpenAI package reference](https://developers.openai.com/plugins/build/plugins)
and [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference).
The endpoint is the only deployment-specific setting. Installing a package
never grants access until the person completes Typeroll OAuth consent.

## Submission checklist — not submitted

- Release and qualify the matching Core endpoint before testing either package.
- Verify OAuth, site selection, edit/preview/save, permission removal and
  revocation in the actual vendor clients. Automated server tests alone are
  not a client certification.
- Prepare a synthetic reviewer organization/site and isolated reviewer identity;
  supply credentials only through the vendor's private review channel.
- Record example prompts: “Work on Example Site in Example Organization”,
  “Find the contact page”, “Draft an opening paragraph and show a preview”.
- Supply the owner-approved product description, screenshots, support contact,
  privacy policy and terms. Have the owner verify the domain/business identity
  and authorize submission in the relevant vendor console.
- OpenAI: submit the HTTPS MCP endpoint and ZIP in the plugin submission flow.
  Claude: submit the endpoint or a published plugin repository through its
  directory submission flow. Vendor review and public listing are external
  steps; do not describe Typeroll as listed before approval.
- Rebuild and review packages when the bundled skill changes. Live site and
  enabled App instructions are always fetched after site selection.

References: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[Claude directory workflow](https://claude.com/resources/articles/build-plugins-for-claude).
