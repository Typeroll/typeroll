# Temporary dependency risk acceptance

## GHSA-fc5q-39xc-vjpf — review before 2026-12-01

The owner approved continuing the page-save performance release on 2026-11-17
with the existing production dependency risk, after comparing the candidate with
production. This is risk acceptance, not a claim that the dependency is safe or
unreachable. Do not interpret a passing audit as remediation.

Production `/api/version` identified Core 0.3.37 at
`beb8d84e95ff9b0d40dded642eaf3f3d9961f04a`. Its lockfile and the 0.3.38 candidate
have identical dependency versions, resolved URLs, integrity hashes and dependency
edges; only the local Core/MCP release versions differ. The reviewed performance
changes introduce no new glob input path, glob call or framework configuration.
The library is reached indirectly through Astro, Vite and associated tooling.
We have not established that every existing indirect runtime path is unreachable.

The advisory describes event-loop denial of service from repeated extglob
patterns. On November 17, npm's latest picomatch was 4.0.7 and
[the advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) listed no patched
version. The upstream PR linked there explicitly does not fix the general
`+(*a)` case. Do not install it as a presumed security fix.

`scripts/audit-dependencies.mjs` accepts only this advisory for the named
picomatch dependency and its transitive advisory chain. The exception is tied to
the complete lockfile fingerprint (excluding only local workspace release
versions) and expires at 2026-12-01 00:00 UTC. Critical severity, additional
advisories, changed dependency contents and expiry still fail. Existing approval
entries cannot implicitly allow high severity.

Review or remove the exception before the deadline. Prefer a verified upstream
fix once available; update all affected versions and confirm the frozen customer
builder fixture as well as Core/MCP and Cloud. If no fix is available, reassess
actual untrusted-pattern reachability and obtain renewed owner approval rather
than extending the date automatically. No new timer or recurring service is
introduced. Private Cloud records its own production baseline and fingerprint.
