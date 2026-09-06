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

## Releases

Core and MCP are independently versioned but published by one ordered train.
Run `npm run release:plan`, bump every affected version source, and push public
`main`. After `Tests` passes, **Release OSS** publishes and verifies Core, then
MCP, then public documentation, and finally records the manifest consumed by
Typeroll Cloud.

Do not create release tags manually. A manual dry run is available through
**Release OSS** when artifacts need inspection without publication. The full
maintainer procedure is in `docs/releasing.md`.
