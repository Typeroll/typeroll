# Platform feedback

Record Typeroll product defects and gaps here, without credentials or private
exports. Distinguish bugs, missing capabilities, unclear instructions and
project choices; project choices belong in decisions.md.

Index:

| ID | Site / Organization | Surface | Summary | Blocks launch | Status |
| --- | --- | --- | --- | --- | --- |

One entry per finding:

```markdown
## DE-03 — <short title>

- Site / Organization / Version: <names and IDs>
- Core / MCP version: <from /api/version or get_site_capabilities>
- Tool or surface: <e.g. trigger_deploy, get_preview_link, core/container>
- Observed: <what happened, with exact error codes, job IDs, URLs, widths and
  timestamps; minimal reproduction; expected versus actual>
- Impact: <what is blocked or wrong, and for whom>
- Ask: <the product change requested>
- Acceptance criteria: <checks that prove it is fixed>
- Workaround: <none, or what was done and how to remove it later>
- Status: open | fixed in <version> | verified <date, version, result>
```

Prefix IDs per site or market (for example DE-03) and never reuse one.

After reporting a defect that affects publishing, do not resume the affected
publishing until the fix is confirmed live: check `/api/version` or the release
note for the fixed version. Then retest against the acceptance criteria and
record the result and version under Status. Verify deployed output before
closing a finding.
