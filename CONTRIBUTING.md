# Contributing

Use Node.js 22 or later and work from a clean checkout.

```sh
npm install
node scripts/oss-release-check.mjs
```

The check matches the main CI release gate, including documentation schema and
formatting checks, type checking, tests, builds, dependency audit, and version
planning.

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

## Public documentation for Cloud and self-hosting

`packages/docs-site/` owns all public user documentation at
`https://typeroll.com/docs/`, including Cloud-specific user workflows. Private
Cloud implementation, credentials and operational runbooks stay in the Cloud
repository. Public documentation does not change a feature's license or service
availability.

For every user-visible change, check the affected editor, UI setup, API/MCP,
publishing, media, domains, versions, Forms, modules, Extensions and migration
guides. Use the public Cloud/self-hosting comparison as the navigation map.
Document shared behavior once; state Cloud and self-hosting differences in
availability, permissions, setup and runtime ownership beside the instructions.
Do not describe planned capabilities as available or promise undeclared Cloud
plans, quotas or service guarantees.

A Cloud-only change still needs its public guide updated here when its user
workflow changes. Coordinate publication with the Cloud rollout and clearly mark
any version or availability boundary. Add a new topic to navigation and the
comparison where relevant. The build generates HTML, individual text alternatives
and agent indexes from the same source; do not maintain separate copies.

For documentation-only changes, run `node scripts/oss-release-check.mjs --docs-only` and the documentation export tests. Run `npm run release:plan` to
confirm artifact scope. Documentation can be published without inventing new
Core or MCP versions; follow the normal release workflow and approval rules.
