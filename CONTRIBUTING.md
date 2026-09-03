# Contributing

Use Node.js 22 or later and work from a clean checkout.

```sh
npm install
npm run typecheck
npm test
npm run build
```

Keep code, identifiers, routes, API fields, test names, and technical logs in
English. Never commit credentials, generated dotenv files, customer data, or
authenticated exports.

Changes to public contracts need tests and documentation. This includes Forms,
Extension manifests and tokens, REST/MCP tools, datastore paths, and generated
site output.

## MCP releases

To release `@typeroll/mcp-server`, bump its version in
`packages/mcp-server/package.json`, refresh `package-lock.json`, and push
`main`. The publish workflow waits for the complete `Tests` workflow, builds
and inspects the package, publishes through npm Trusted Publishing, verifies
the exact version on npm, and then creates the matching `mcp-vX.Y.Z` tag.

Do not create the release tag manually. A manual dry run is available through
the **Publish MCP server** workflow when the package artifact needs inspection
without a release.
