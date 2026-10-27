# Repeatable site QA

These optional tools supplement MCP and the platform's publication validator.
They do not publish, change DNS, approve a launch or replace visual review.
Python tools use the standard library except contact_sheet.py (Pillow). Browser
tools require Node.js 22+, Playwright and its Chromium browser. From scripts/typeroll:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

Run the commands below from the **workspace root**. Inject TYPEROLL_API_KEY through
your private credential manager. Never put it in a file or command argument.
trlib.py reads portal, organization_id, site_id and version from typeroll.json,
sends the key only to https://app.typeroll.com or to a portal you confirm by
setting TYPEROLL_API_URL to the same origin privately, checks the connected Site/Organization, discovers the live tool schema, and
passes the Version where supported. It refuses unversioned operations on a
non-main binding; use the explicit interactive API workflow for organization or
shared media operations instead. It is a small hosted MCP helper for API keys,
not a replacement OAuth client or a new general CRUD CLI. REST is also supported
by Typeroll if your integration already uses it.

## Before publication

```sh
python3 scripts/typeroll/check_unsaved.py
```

Exit 1 lists unsaved Pages **and partials**. Review those changes; save only the
work authorized for this publication, then run again. Templates save immediately.
A working-copy preview is not proof of saved output. Never auto-save other work.

## After an authorized publication

```sh
python3 scripts/typeroll/check_url_parity.py https://YOUR-TEST-HOST
python3 scripts/typeroll/check_assets.py https://YOUR-TEST-HOST
node scripts/typeroll/shoot_hosted.cjs https://YOUR-TEST-HOST qa/reports/hosted /,/about/ 390 768 1023 1024 1280
node scripts/typeroll/card-stacking-check.cjs https://YOUR-TEST-HOST/listing/ 390
```

URL parity reads every migration inventory page and observed spelling, skips
explicit exclusions unless --show-excluded, keeps origins/query parameters,
detects loops and flags chains beyond a single redirect (one initial slash
normalization is allowed). This does **not** prove the final destination is the
editorially correct page: compare with the approved URL map too. No inventory
is a failure, not a passing zero-row check. Asset QA uses resolved routes,
checks published/unlisted Pages, relative URLs, srcset and downloads, uses four
concurrent HEAD requests and falls back to GET when HEAD is unsupported. CSS
backgrounds, authenticated assets and dynamically loaded resources need browser QA.
Neither tool spoofs a search crawler. A 403/DNS/network failure is unverified;
inspect access policy rather than treating it as a broken migration or a pass.

## Other helpers

- `call.py TOOL '{"argument":"value"}'`: raw MCP result; use `-` to read JSON
  from stdin. Mutating tools require the same owner authorization as interactive
  calls. Network failures are not automatically retried for mutations.
- `trlib.upload(path, content_type, alt)`: direct signed upload and mandatory
  finalize SHA-256 verification. No image bytes pass through the model or Git.
- `sweep_blocks.example.py`: dry-run grid normalization across Pages, templates
  and partials. Review before --apply; refuses to commit existing unsaved work.
  It is not transactional: a failure can leave a partial draft; inspect before retry.
- `shootframe.cjs OUT-PREFIX SIGNED-PREVIEW-URL [widths...]`: selects only the
  Typeroll preview iframe, reports fonts/hosts/overflow. Signed URLs are secrets;
  pass privately, never paste into committed reports or shell history. Direct-frame
  capture checks rendering only; test Extension storage/navigation/handoffs in
  the original wrapper because those features depend on its parent bridge.
- `layout_trace.cjs URL [width] [selector]`: computed spacing of ancestors and
  next section. Works with a direct page or Typeroll preview.
- `contact_sheet.py OUT-PREFIX COLS TILE-WIDTH PNG...`: Pillow contact sheets.
  It crops tall screenshots; inspect full screenshots too.
- `capture_text.cjs URL qa/reports/text.json 'main .article-content'` followed by
  `compare_text.py sources/private/page.html qa/reports/text.json --source-title 'Title'`:
  word/punctuation diff. A saved single WP REST record (.json) is another source
  adapter. Select exactly the preserved region, including its template-owned
  title once. Deliberate shared additions need separate acceptance. Comments,
  scripts and styles are excluded from source text. It never edits content.

Browser reports exit nonzero for missing images, overflow, unexpected H1 count,
failed requests or incomplete scrolling. They keep third-party failures visible.
Network checks retry only a bounded read. All reports, screenshots and source
exports stay under ignored qa/reports/ or sources/private/. Do not commit signed
URLs, personal data or customer assets. Adapt scripts deliberately and run tests
before applying broad changes. The workspace updater preserves your edits.

## Palette migration (Core 0.2.106 / MCP 0.45.80+)

`color_tokens.py --plan /tmp/design-token-plan.json` runs the read-only
`lint_design_tokens` audit and lists unambiguous direct block hex replacements.
Review the plan and remove deliberate exceptions. `--apply /tmp/design-token-plan.json`
requires the same site/palette and a dedicated non-main Version without existing
working copies. Pause other editing in that Version during the run: ordinary
field writes do not provide a site-wide transaction. The script refuses stale
values, never retries uncertain writes, and never publishes. On an interruption,
inspect working copies before saving or resuming. Templates save immediately.

Ambiguous colours, nested/responsive colour maps and custom CSS are reported for
manual review rather than rewritten. API updates through the normal block tools
can resolve these after choosing the semantic role. Run lint again and compare
header, footer, navigation, cards and buttons at all breakpoints. Keep generated
plans outside Git; they are version-specific review artifacts.

## Local image preparation

`prepare_image.py SOURCE OUTPUT.jpg` requires Pillow with ImageCms. It converts
through the original ICC profile to sRGB and applies orientation, without
uploading or changing CMS content. Missing CMYK profiles, transparency, multiple
frames and existing output files stop with an error. `--assume-srgb` is only for
reviewed unprofiled RGB/gray; `--source-profile FILE.icc` supplies the actual profile.
See workflows/source-media.md for archive verification and original preservation.

## Internal Page notes

`page_notes.py --dry-run` previews local note creation/fact refresh and index updates.
Omit --dry-run to write local files; --migration-inventory adds recorded redirect
sources. It never writes to the CMS, marks a Page reviewed or deletes notes. Read
pages/README.md and workflows/page-notes.md before first use.

### Heading rhythm after a rebuild

`node scripts/typeroll/check_heading_spacing.cjs https://example.com [paths.json]`
checks opening component headings and card spacing at 375, 768 and 1280px.
`paths.json` is an array of same-origin page paths; otherwise it reads a flat
sitemap. Requires Playwright and its Chromium browser. Findings need visual
review: deliberate asymmetric cards belong in decisions.md. It is a read-only
QA helper, not a publication gate or a CSS repair tool.
