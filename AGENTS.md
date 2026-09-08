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

- User-facing copy uses Organization and Site. Never label or address an
  organization as an agency; it may manage only its own websites. Keep
  organization-wide connections distinct from each site's domain and content.

- Make publishing and domain workflows available through the authenticated
  public API and MCP as well as the UI. Support external agents applying DNS
  changes through their own provider access; return structured requirements
  and independently verify results with the same authorization checks.

- Support separate website and media hosts. Freeze future origins in a verified
  publication before traffic cutover. Storage migration must preserve media
  identities, concurrent edits and late uploads, verify copies before switching
  references, and route new uploads to the verified destination immediately.

- Hosting Groups own hosting account connections and site address bases. The
  Organization owns shared R2 media, its media hostname, DNS access and GitHub.
  Default reuses the existing connection without duplicating OAuth grants.
  See `docs/hosting-groups.md` for migration, static media and account boundaries.
