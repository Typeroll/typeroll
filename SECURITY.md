# Security policy

Please report suspected vulnerabilities privately through GitHub's security
advisory feature for `Typeroll/typeroll`. Include the affected version,
reproduction steps, expected impact, and any suggested mitigation.

Do not include credentials, real customer data, recipient-link tokens, session
cookies, or production exports in a report.

## Dependency policy

Run `npm run security:audit` after changing dependencies. CI and Core releases
run the same command. It rejects every critical or high-severity advisory and
every advisory that is not explicitly approved in
`scripts/audit-dependencies.mjs`.

Temporary approvals must identify one advisory, explain why its vulnerable
code is not reachable in Typeroll, and have a review deadline. Do not use
`npm audit fix --force` or broad severity exemptions to make the gate pass.
