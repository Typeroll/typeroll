# Typeroll open-source development

- Use Node.js 22 or later.
- Run focused tests first, then `node scripts/oss-release-check.mjs` for shared
  or release-facing changes. This is the same fail-fast gate as main CI.
- Forms, the Extension protocol, WordPress migration and helper plugin, the
  portal, the public API, MCP, and the static renderer are open-source core
  functionality.
- Do not add Typeroll Cloud deployment credentials, operator-only routes,
  managed-service operations, marketing code, billing, or premium Typeroll
  Apps.
- Keep customer sites static. Dynamic Forms and Extension requests go directly
  to the runtime owner documented by the public architecture.
- Keep code, identifiers, comments, routes, API fields, tests, and logs in
  English.
- Never commit credentials, tokens, cookies, personal data, or authenticated
  exports.
- Public `main` is the release source. Keep each artifact's package version and
  runtime version literals in lockstep; Core and standalone MCP are versioned
  independently. Run `npm run release:plan` and never create release tags
  manually. Successful main CI runs the ordered Core, MCP, docs, and
  release-manifest workflow in `.github/workflows/publish-mcp.yml`.
