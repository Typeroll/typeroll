# Changelog

## Unreleased

- Fixed: hidden steps of a multi-step form showed when site CSS set a display on steps (for example `[data-form-step] { display: contents }`), so every step appeared at once. The form shell CSS keeps hidden steps and the hidden dynamic-step container hidden (`display: none !important`). The platform CSS reference changed for every render version; pages without such site CSS render as before.
- Forms work in every preview without setup: the editor's preview, Preview site, preview links, page and revision previews and `get_page_preview`. The forms runtime runs in preview mode: each step is validated with the server's rules and messages, steps advance (dynamic steps included) and the last step shows the success message; a redirect is named ("Preview – would redirect to /tack/") instead of leaving the preview. A "Preview – nothing is sent" notice ("Förhandsvisning – inget skickas" on Swedish sites) marks the form. Nothing is stored and no email, webhook or app action runs. Previews used to post real submissions.
  - Preview forms carry no submit token and post to the core endpoint, which refuses their `_preview` marker (403, also for no-JS posts), so a preview can never create a submission. Only the portal's preview renderer emits preview mode; published pages never contain it.
  - Extension components in previews: `forms.submit()` resolves `{ v: 1, ok: true, done: true, preview: true }` without a request instead of throwing "Extension form submissions are not configured".
  - New template capability `forms_preview_mode` (template capabilities 0.51.0). The `get_page_preview` and `get_preview_link` descriptions and the tr-forms skill describe preview forms.
- Fixed: a multi-step form with a required field after step 1 could not be completed. The browser's own validation also checked the hidden later steps, so sending step 1 failed silently ("An invalid form control is not focusable"). The forms runtime now disables the fields of hidden steps, so native validation and the posted data cover the visible step only, and enables them when their step shows. The server still validates each step's fields. A form with a dynamic step no longer posts every later step twice.

## Core 0.2.64 / MCP 0.45.48

Connect GitHub can no longer stop without saying what to do next after the App installation.

- Publisher setup: the GitHub App's **Setup URL** must be `{PORTAL_PUBLIC_URL}/api/orgs/publishing/github/callback` with **Redirect on update** selected, and **Request user authorization (OAuth) during installation** stays off. Without the Setup URL, GitHub leaves people on its installation settings page instead of returning them to Typeroll. The setup documentation no longer says the App does not need one.
- A return to the callback with `setup_action` but no matching `state` (installed or updated from GitHub directly, or an installation link older than 10 minutes) records and consumes nothing and never trusts `installation_id`. The card opens with `?github=installation_returned` and checks again, or explains an owner-approval request (`install_requested`).
- The GitHub card checks again by itself when Publishing opens and when its tab regains focus, while the person's GitHub sign-in is less than an hour old and GitHub is not connected yet: at most once per 10 seconds, with the result announced in the card. A reload no longer shows a stale "not installed". While an installation started from Typeroll is pending, the card says "Back from GitHub? We check automatically — or select Check again." `GET /api/orgs/publishing` returns `github_attempt` (`recheck_available`, `installation_started_at`) for this.
- A personal account that is ready on GitHub is connected with **Connect @login** ("GitHub asks you to confirm once; you come straight back here."), and the summary names the step ("Connect @login to finish."). "Sign in to GitHub to connect @login" is shown only when the sign-in is older than an hour. Other summaries name the next step or who must act instead of "One step below is needed."
- Each reason shows **Who acts: …** as its own label above the sentence. "GitHub organization owner @login is not an owner of Moveria-AB" read as one garbled sentence. Reasons no longer lowercase account names ("an owner of Moveria-AB must …").
- New blocker code `setup_url_missing` (`who: publisher`): an installation started from Typeroll found on an account the person owns, but no return to the callback within two minutes. It is a note for publishing admins that links to the App settings and changes neither the outcome nor the next step.

## Core 0.2.63 / MCP 0.45.48

- Form email notifications with "Append all submitted values" (`include_all`) list the values under the field labels shown on the form, in form order, instead of the field names. Choice fields show the chosen option's label, empty hidden fields (such as `utm_*` parameters) are left out and multi-line answers keep their line breaks. Plain-text emails use `Label: value` lines with the same rules. Stored submissions, webhooks and the form and action APIs are unchanged.
- Fixed: a checkbox group with several ticked boxes stored only the last ticked value. A checkbox group's answer is now always the list of ticked values, with or without JavaScript and in the JSON submit API: one ticked box (also when sent as a single string) is stored as a one-item list and no ticked box as an empty list. Other fields keep a single value.
- Fixed: action links in the portal AI chat pointed every changed item to the page editor, so block types and global blocks (header, footer, free blocks) opened a missing page. Each chat action now carries its editor link: "Edit page", "Edit global block", "Edit template" or "Edit block type", and a deleted block type has no link. Saving or discarding a global block's draft is reported as a global block change (`update_partial`) instead of a page change.

## Core 0.2.62 / MCP 0.45.47

Connect GitHub now explains every way it can stop, who must act and how, in the GitHub card, the API and MCP.

- GitHub connection diagnosis:
  - Every exit of the GitHub flow (sign-in callback, installation return, account choice, Check again) stores a diagnosis for 24 hours, bound to the person and the connection revision. It lists every account with the publisher App, whether it can be used, and each blocker with `who` (`you`, `github_owner`, `publisher`, `typeroll_admin`) and one action. No tokens or GitHub responses are stored or returned.
  - An unfinished attempt is shown only to the person who made it. Other admins see the state of a saved connection, and the API and MCP see the organization's state without anyone's GitHub login, other accounts or single sign-on links. One person's failed or cancelled sign-in never marks a working connection as needing attention.
  - A callback is recorded only for the sign-in that the same person started in the same browser, so a link to the callback from another site changes nothing.
  - New blocker codes, documented in the new [GitHub connection troubleshooting](https://typeroll.com/docs/guides/github-troubleshooting/) guide: `not_org_owner`, `membership_unverifiable`, `sso_authorization_required`, `repository_selection_limited`, `permissions_update_pending`, `permissions_missing`, `installation_suspended`, `other_users_personal_account`, `locked_to_account`, `claimed_by_other_organization`, `no_installation`, `install_request_pending`, `oauth_cancelled`, `state_expired`, `session_expired`, `wrong_browser`, `github_unavailable`, `github_rate_limited`, `revision_conflict`, `expiring_tokens_disabled`, `publisher_app_misconfigured`, `encryption_unavailable`.
- Fixes in the GitHub flow:
  - Each installation is checked on its own. Single sign-on, a rate limit or an outage on one organization no longer aborts the others, Members write access is accepted, and a rejected installation no longer changes the reported reason (a missing permission elsewhere used to hide "not an owner").
  - Cancelling on GitHub, an expired or reused sign-in, a return in another browser, an owner-approval request (`setup_action=request`) and GitHub errors each get their own explanation instead of `?github=failed`.
  - A sign-in that returns after the Typeroll session ended goes to sign-in and back to the GitHub card instead of showing raw JSON. Sign-in accepts a same-origin `/app/` return path.
  - Saving the GitHub installation that is already connected is no longer a conflict.
  - Publisher setup reports a missing App and missing encrypted storage separately (`github_setup.app_configured`, `github_setup.encryption_available`, `github_setup.app_slug`).
- After an explicit disconnect, an Organization can connect a different GitHub account once it confirms which account it replaces. Existing repositories are not moved. A GitHub account connected to another Typeroll Organization still cannot be connected.
- Portal: the GitHub card is a five-step guide (publisher ready, signed in as @login, account with the App, access and permissions, connected) with one primary next action, a fix beside each reason and **Check again**. Returning from GitHub focuses and announces the result inside the card; GitHub no longer uses page-level alerts. Cloudflare is unchanged.
- **Check again** (`POST /api/orgs/publishing/github/diagnosis`) re-checks with the publisher App's access and the GitHub identity the same person proved by sign-in within the last hour; after that it asks for a sign-in. It consumes nothing and connects nothing by itself: a usable organization becomes a choice the person confirms within 10 minutes and within the hour of the sign-in, and ownership is verified again before saving. An organization the person names but does not own gets the same answer whether or not the App is installed there.
- Every state of the GitHub card offers a next step that works, including an expired account choice and a request waiting for an organization owner. Opening the App installation no longer interrupts another admin's sign-in in progress, and a renewed personal-account authorization is saved even if the connection changed meanwhile.
- API and MCP:
  - New `GET /api/v1/publishing/github-diagnosis` (`?recheck=true` re-checks a connected installation) and MCP tool `diagnose_organization_github_connection`. Organization API key required.
  - `POST /api/v1/publishing/connections/github` answers 409 with `connect_url` and `diagnosis`.

## Core 0.2.61 / MCP 0.45.46

- Accordions with "Default open" open again: both sanitizers keep the `open` attribute on `<details>` (render version 4).
- The SEO audit workflow audits block pages from their rendered blocks. It read only `html_content`, so every block page was reported as thin content without an H1.

## Core 0.2.60 / MCP 0.45.46

Sites can define their own block types, built from existing blocks or written as markup, and edit them in a visual builder.

- Site block types:
  - Composed types (`composition`) are built from existing blocks. The schema declares the type's fields, and inner blocks bind them as `{{props.title}}`. A repeater without `item_block` renders its children once for each item of a list field (`{{item.title}}`). Composed types can contain other composed types.
  - Template types (`template`) write their own markup. They can loop with `{{#each}}` and `{{@number}}`, test for empty values with `{{^field}}`, and link with `{{#link field class="…"}}`.
  - New `link` field type (`{ page_id?, url?, new_tab? }`). It resolves to a safe `href`, `target` and `rel`, and a link to a page follows when the page's slug changes.
  - A block type's stylesheet is scoped to the block (`:scope`, `css_scope: block`). Page-wide selectors such as `body {}` are refused.
  - Starters: icon list, feature cards and numbered steps.
- One write path for block types in the portal, the API, MCP and the chat:
  - Every write goes through the same validator. Errors refuse the write and list every problem with its JSON path or template line; warnings are returned with the result.
  - New endpoints `validate`, `preview` and `starters` (MCP `validate_block_type`, `preview_block_type`, `list_block_type_starters`). The preview renders an unsaved definition with the site's theme, styles and render version.
  - **Contract change:** creating and updating a block type now responds with `{ block_type, warnings, impact? }` instead of the bare block type.
  - Updates take `renames`, which move the data on every page, draft, template, header, footer, global block and repeater item. An update that removes or retypes fields holding data answers 409 with the affected uses, unless it sends `confirm_data_loss: true`.
  - Usage follows compositions, repeaters, drafts and block templates. A block type cannot be deleted while it is used.
  - `.tcblocks` export and import is lossless and takes `on_conflict`: `skip`, `rename` or `replace`.
  - Only admins can create, change, delete or import block types. The chat writes `script` only when the site allows AI block scripts.
  - On a site below render version 4, the write warns when an icon sits inside a linked container, because the links would nest.
- Portal:
  - A block type builder on the Blocks page, with the tabs Fields, Blocks (with "Bind to field"), Markup, CSS, Preview, Usage and JSON.
  - "Turn into block type…" makes a type from a selected section and replaces the section with an instance of the type. "Detach into blocks" reverses it.
  - In the inspector, list items can be collapsed, reordered by dragging or with Move up and Move down, duplicated and removed with undo. The inspector also gains icon, link and image pickers.
- New `core/text` block: plain text in a chosen element. `core/container` can open its link in a new tab.
- Render version 4:
  - Accordion items render as expandable sections, and "Default open" opens the first item or every item.
  - Pricing plan features and team member social links render, and excluded features are marked.
  - An icon without a link no longer sits in an empty link.
  - A container set to be a link renders as a plain container when it has no address, and so does a team member card without a link.

## Core 0.2.59 / MCP 0.45.45

Everything the portal can do is now available through the authenticated API and MCP, with the same permission checks. The portal chat assistant keeps its narrower tool set.

- Settings and sites:
  - `update_site_settings` takes every field the Settings form takes (`default_og_image`, `twitter_handle`, `organization`, `staging_url`) and, like the form, needs admin.
  - `update_site` sets `ai_scripts_enabled` (admin). API block and block type writes no longer carry a script notice.
  - Archive and restore a site (`archive_site`, `restore_site`), purge an archived site's media (`purge_site_media`), and read upload status (`get_media_upload_status`).
  - The API page preview renders block scripts, the Extension runtime and the cookie banner, like the portal preview.
- Email and forms:
  - Outgoing email provider: `get_email_settings`, `set_email_settings`, `delete_email_settings`, `send_test_email` (admin; secrets are write-only). The portal gains Disconnect.
  - Incoming email through MCP (`get_incoming_email_settings`, `set_incoming_email_forwarding`, `read_incoming_email_receipt`); portal and API share one implementation.
  - `get_form_capabilities` lists core and app-provided action types; `read_form_submission` reads one entry. Admins see webhook delivery status, and deleting submissions removes their delivery records.
- Branches, history and Extensions:
  - `diff_version` and `reset_version`. Creating, merging, deleting and resetting branches needs admin, as in the portal.
  - Partial (header, footer, global block) revisions: list, read, restore. `preview_page_revision` renders an earlier saved state.
  - Install, enable or disable, uninstall, pair, diagnose and launch Extensions; Extension developer tools for organization keys.
- Organization administration and workflows:
  - List and revoke site and organization API keys, share a site and create invites (`list_api_keys`, `revoke_api_key`, `share_site`, `create_organization_invite`, …). A share never reaches further than the caller.
  - New secrets stay in the portal: creating API keys, rotating Extension server credentials and registering an Extension or rotating its client secret are not available through the API or MCP, so a secret never lands in an agent conversation or log.
  - Workflows: start, read and approve (`start_workflow`, `get_workflow`, `approve_workflow`), and `create_site_and_migrate` / `create_site_and_plan`. Rebuild & deploy needs admin; workflow reads no longer expose the WordPress helper key.
  - Organization publishing connections: status, Cloudflare token connect, media storage, disconnect.
- Global blocks:
  - Usage covers page templates, header and footer and other global blocks, saved or in a draft.
  - Detach copies the draft the editor shows when there is one.
  - Block-mode header and footer use the block-tree editor with Save draft / Discard draft.
- End-to-end tests wait for visible UI state instead of network idle.

## Core 0.2.58 / MCP 0.45.44

- Remove HTML-to-blocks conversion. A heuristic conversion cannot reproduce designed pages faithfully.
  - Gone: the page-level conversion preview, the text-block **Convert into blocks** action, their API routes, and the MCP and chat tools `convert_page_to_blocks` and `convert_prose_block`.
  - HTML pages stay HTML. Switching a page to blocks starts an empty block tree and keeps the HTML as a revision; the content is then built with blocks.
- WordPress import keeps its lazy-media clean-up, now in its own module.
- API and MCP can do what the portal can with forms:
  - Read and write a form's email notifications and webhooks (`actions`, admin keys; webhook secrets are masked and kept when unchanged).
  - Docs and agent instructions no longer say notifications are hidden from agents. The portal chat assistant still has no notification or submission tools.
- API keys and MCP write Page fields with the same authority as an editor in the portal. They may write every field open to the portal or agents, and portal, API and MCP edits replace each other; the latest edit wins. Machine passes inside Typeroll (the portal chat assistant, AI workflows) still never replace an editor's value. Replacing a value the listed business set needs `override_reason`, in the portal and the API alike.
- App installation credentials never read or write form actions.
- Render version 3: the theme tokens blocks reference (`--color-bg`, `--color-bg-subtle`, `--color-border`, `--color-secondary-fg`) come from the site palette instead of fixed greys. Versions 1 and 2 render unchanged.
- Update devalue to 5.9.4 for new security advisories.

## Core 0.2.57 / MCP 0.45.43

- Add render versions. Each site keeps its rendering until someone previews and upgrades it in Settings → Rendering or through the API and MCP. New sites start on the latest version, and reference snapshots guard every released version.
- Render version 2:
  - A heading's eyebrow and new subtitle are grouped in `<hgroup>`, take named styles and are never faded.
  - A block's custom class lands on the heading or button link itself.
  - Text on primary-coloured buttons is black or white, whichever reads better.
- Add named styles. Sites get a style library with element roles (body, H1–H6, links) and class styles chosen per block.
  - Values are set per breakpoint, there is a standard set for new sites, and text below WCAG AA contrast is refused.
  - The library is available in the UI, the API and MCP (`list_styles`, `create_style`, `update_style`, `delete_style`, `apply_standard_styles`).
- Improve the text editor:
  - Paragraph styles: Heading 2–4 and the site's text styles.
  - Preview-first conversion of unsupported markup into blocks (`convert_prose_block`).
  - HTML import folds a classed eyebrow or subtitle into its heading.
  - Block writes warn when a heading label is written as a text block.
- Manage site and page CSS with line numbers and live checks. Syntax errors and script-capable CSS are refused; selectors on platform markup produce a warning. Stored CSS can no longer close its `<style>` element.
- Show CSS class and anchor under a block's Advanced settings.
- Add reusable blocks:
  - Global blocks are referenced from block pages (`core/global_block`) and render in place. A section can be made global or detached.
  - Block templates are saved section starters that are copied into a page.
  - Both are available in the UI, the API and MCP.
- Fix low-contrast text in the editor and admin, and keep a block global block's mode when it is saved.

## Core 0.2.56 / MCP 0.45.42

- Make preview match the published page: same head CSS order (template base CSS after site and page CSS), shared theme and webfont fallback rules, and media URLs rewritten for every media id format.
- Search page content in block data, HTML bodies and text fields.
- Let a container render as a link (`tag: a` with a safe `href`) and let headings inherit their container's alignment.
- Add an optional form `success_redirect_url` (path or http(s) URL) and render the success message as sanitized HTML for visitors without JavaScript.
- List, read and restore page revisions through the API and MCP; restore uses the draft path and keeps publication state.
- Point branch documentation at each version's reported `deploy_url`.

## Core 0.2.54 / MCP 0.45.41

- Stop automatic HTML-to-blocks conversion from rewriting a page. Mode switches, agent tools, WordPress import, and the unified Pages migration keep HTML bodies intact.
- Offer the heuristic only as a preview that lists text, classes, and markup it could not convert. A person accepts that preview in the page editor.

## Core 0.2.40 / MCP 0.45.33

- Add provider-independent navigation inputs with same-origin, bounded tab defaults and explicit receiver fields; preserve safe navigation without storage or JavaScript.
- Render accessible mixed service tabs/direct links with responsive disclosure, native presentation controls and working static slots.
- Support decorative missing-thumbnail panels and deliberately compact mobile footer navigation without changing comfortable defaults.
- Document migration discovery, responsive composition and privacy boundaries in public guides and MCP recipes.

## Core 0.2.39 / MCP 0.45.32

- Add a guarded, idempotent Retry verification action in the portal and authenticated API/MCP for timed-out, already-served customer publications.
- Reuse the exact job and artifact; run real public checks and normal CMS finalization without source generation, build dispatch, upload or DNS changes.
- Reject superseded jobs, changed publishing modes, incomplete receipts and unrelated failure types; preserve the original failure and durable retry identity.

## Core 0.2.38 / MCP 0.45.31 unchanged

- Allow retired native image variants on public hosts only when the frozen artifact retains the exact original image bytes. Keep candidate removal checks and checks for deleted or replaced originals.
- Recover already-running publications from older saved probe lists using the full frozen manifest and a new verification-policy checkpoint. No rebuild or manual job reset is required.

## Core 0.2.37 / MCP 0.45.31

- Include full original-width AVIF/WebP candidates in static publishing and explicit media generation, without upscaling or duplicate widths.
- Coordinate v2 immutable variant keys, scoped grants, completion receipts, aliases and preparation state; preserve originals and old public URLs.
- Verify actual encoded dimensions, frozen publication HTML, browser selection and warm-cache reuse.

## Core 0.2.36 / MCP 0.45.30

- Extend recognizable, keyboard-visible text links to native lists, tables, image captions and other rendered rich-text surfaces, preserving interactive card, image, button and navigation styling.
- Verify real frozen output, renderer cache invalidation and mobile/desktop computed styles; document adoption through republication.

## Core 0.2.35 / MCP 0.45.29

- Keep prose text links visibly underlined across theme resets without changing native buttons, cards or navigation.
- Wrap breadcrumb titles continuously while preserving ordered-list semantics.
- Add responsive image framing, fit/aspect and focal controls; keep intrinsic, uncropped defaults.
- Add shared body heading scales and spacing to Page content slots and containers; fix responsive heading alignment.
- Parse original migration HTML with browser tree-construction rules and convert image-only headings in place. Existing content is not rewritten automatically.

## Core 0.2.31 / MCP 0.45.25 unchanged

- Acknowledge SES internal setup notifications after topic, signature and storage
  route verification, without customer alerts, receipts or quota consumption.
  Ordinary mail and lookalike identifiers keep their existing checks.

## Core 0.2.30 / MCP 0.45.25 unchanged

- Allow incoming SES callbacks through portal middleware without a browser Origin.
  Keep exact SNS topic and cryptographic signature verification in the handler;
  neighboring routes and browser settings retain CSRF protection.
- Verify signed notifications and subscription confirmations through the complete
  middleware and route chain before activating incoming email forwarding.

## Unreleased — Core 0.2.28 / MCP 0.45.24

- Add versioned site breakpoint widths with editor/API/MCP parity and exact block
  visibility ranges. Preserve explicit menu and theme thresholds.
- Add native prose typography, container minimum height, short Page breadcrumb
  labels and Post Card action/icon presentation. Fix responsive card media width.
- Advertise template capabilities 0.47.0; existing sites require republication.

## Unreleased — Core 0.2.27 / MCP 0.45.23

- Generate agent-neutral site workspaces with briefs, decisions, QA, non-secret
  Site/Organization/Version bindings and hash-based updates that preserve edits.
- Add read-only workspace diagnostics and optional local client adapters.
- Offer compact MCP discovery with five stable tools, on-demand schemas and
  separate read/write/admin execution. Full mode remains available.
- Add paginated site discovery and section-based guide reads. Document client
  context costs, safe project files and the current CLI/API boundary.

## Unreleased — Core 0.2.26 / MCP 0.45.22

- Require explicit per-installation activation across declared app release boundaries.
- Add scoped idempotent mail receipts, SES delivery events, quotas and suppression;
  keep unknown acceptance out of automatic retries. Receiving mail is not included.
- Retain immutable item identities and keyed provenance in owner descriptors and
  batch API writes. Branch edits cannot mark main for auto-publication.
- Add block-authored menus with optional independent mobile composition, typed
  article-card presentation, and numeric icon sizing. Preserve full content-slot
  width when typography is applied. Strengthen migration coverage requirements.
- Extension runtime 0.42.0 identifies the activation/mail contract; candidate apps
  require it before installation. No customer site is automatically republished.

## Unreleased — Core 0.2.24 / MCP 0.45.20 unchanged

- Accept bounded, valid SEO reports above 8 KiB on authenticated build completion
  and failure callbacks. Keep publishing-account and other runner requests at
  8 KiB; count streamed UTF-8 bytes and preserve artifact/lease validation.
- Report an explicitly rejected oversized diagnostic with a small failure
  callback, so an engine does not appear to lose contact while its error is known.
- Run release source, browser and dependency checks independently. Reuse the
  exact qualified documentation artifact and cached Core image build layers.

## Unreleased — Core 0.2.18 / MCP 0.45.18

- Preserve ordinary URL anchors and their encoding during Extension context
  cleanup unless a fragment parameter was actually consumed. Keep the exported
  helper and generated browser runtime aligned; existing sites need republication.

- Reuse verified media assets already present in the target Pages project before
  downloading originals and variants from R2 in shared Cloudflare/GitHub builds.
- Scope completed upload receipts to each Organization, Site, version and hosting
  target. Recheck availability before upload and fall back to complete local
  output when assets or receipts are unavailable. Preserve atomic deployments.
- Report media reuse and stage timings in build logs; document the first-build
  baseline, independent-build behavior and remaining publication work.

## Unreleased — Core 0.2.8 / MCP 0.45.8

- Reuse immutable per-image completion receipts during publication instead of
  downloading originals, variants and aliases again during preparation.
- Fetch and verify only artifacts required for static output; reuse local files
  across overlapping retained media manifests. Preserve source, path, storage
  and encoder boundaries, bounded grants and interrupted-build recovery.

## Unreleased — Core 0.2.7 / MCP 0.45.7

- Add opt-in article body spacing to Page content slots and editorial starters.
- Keep sticky contents and linked headings below responsive site headers;
  scroll long desktop outlines within the available viewport.
- Add boxed Post Cards for related-article groups using native containers.
- Document template settings and add browser regressions for spacing, header
  clearance and card presentation. Existing sites need republication.

## Unreleased — Core 0.2.4 / MCP 0.45.4

- Split customer publication into durable source, Git and build-dispatch steps.
  Reuse the frozen source during recovery, renew active ownership and enqueue
  scheduled recovery without running builds in the global sweep.
- Capture version content consistently, store snapshot parts with bounded
  concurrency and reuse unchanged per-record Git blobs. Rendering remains full.
- Resolve website/media references in the frozen customer renderer; preserve
  branch identity, media aliases, old renderer snapshots and independent builds.
- Observe waiting builds without reloading source or probing unrelated providers.
  Retry temporary service failures and report safe checkpoint timing metadata.
- Update publishing documentation and API/MCP guidance, including the narrower
  source-only meaning of a customer-publishing dry run.

## Core 0.2.3 / MCP 0.45.3

- Keep article contents in normal flow on mobile while preserving the sticky
  desktop sidebar. Wide tables scroll within columns without widening the page.
- Add browser regression checks for scrolling and layout at mobile and desktop
  widths. Existing static sites need republication to receive the fixed styles.

## Unreleased — Core 0.2.0 / MCP 0.45.0

- Content types define allowed Page templates and default sorting. Pages can
  override the template or inherit it, and edit their manual order through the
  normal Save/Discard flow. Listings and neighbouring-page links share defaults.


- Unify all content as Pages with Content types, custom fields, block bodies,
  shared Page templates, one editor, history, preview and publication flow.
- Remove the old Collections API, tools and runtime storage model. Existing
  installations require the schema 2 migration before starting this Core version.
- Update public guides, API/MCP help, generated agent instructions, site-kit
  checklists and example data for the new model.
- Retain source-site paths, references, branch inheritance, working copies and
  revisions through the one-time migration. No runtime compatibility aliases.

Entries below describe historical releases, including APIs removed in 0.2.0.
They are not instructions for the current model.

## MCP 0.44.49 / Core 0.1.76

- Start media migrations immediately and continue bounded tasks without waiting
  for the scheduled publish sweep. Resume large libraries from durable cursors,
  preserve late uploads and edits, and retry interrupted transfers automatically.
- Show verified copy progress and automatic continuation in Publishing.
- Explain the next shared-build setup action and distinguish choosing an
  existing Cloudflare build token from creating one.

## MCP 0.44.48 / Core 0.1.75

- Keep publisher App authentication failures separate from personal user grant
  renewal. A publisher-side failure does not revoke the stored user grant or
  incorrectly ask the account holder to reconnect.

## MCP 0.44.47 / Core 0.1.74

- Connect personal GitHub accounts alongside organizations through the same
  publisher App, with verified ownership and explicit account selection.
- Create personal site and shared-build repositories using encrypted, renewable
  user authorization. Existing publication, version branches and build dispatch
  continue using installation tokens.
- Serialize token renewal across instances, preserve disconnects, and provide
  an explicit reconnect action when repository authorization expires or is revoked.
- Prepare the generated main branch independently of the account's initial
  default branch, and retain organization publishing compatibility.
- Update Publishing instructions, account labels and public setup documentation.

## MCP 0.43.9 / Core 0.1.17

- Keep sign-out outside the scrolling navigation so it remains visible on
  short mobile screens after adding organization switching.
- Enable organization forms and the selector only after hydration, preventing
  native form submission or lost changes while their JavaScript loads.

## MCP 0.43.8 / Core 0.1.16

- Added browser-session organization switching and multiple memberships per user.
  Creating or joining another organization preserves previous memberships.
- Revalidate selected memberships on every session read, preserve roles when
  joining again, and enforce roles for newly created organizations.
- Keep organization selection separate from Firebase identity claims and clear
  site-version selection when switching or signing out.
- MCP carries the updated Core version contract; no MCP tools have changed.

## MCP 0.43.7 / Core 0.1.15

- Added organization publishing account settings with GitHub App OAuth and
  PKCE, verified GitHub organization ownership, and reusable account claims.
- Added Cloudflare account/Pages checks, R2 upload/readback/cleanup verification,
  encrypted credentials, and revision-protected rotation and disconnect.
- Publishing accounts require an explicit organization owner or admin role,
  including organizations using legacy permissive role settings.
- Site provisioning, editor publication through Git, public media delivery,
  and full portable exports remain under development. MCP carries the updated
  Core contract version; no new MCP tools are introduced in this release.

## MCP 0.43.6 / Core 0.1.14

- Included transitive alias and repeater item CSS/JS in static builds and
  previews, including dependencies in partials and referenced form steps.
  Preview script restrictions still apply to the complete bundle.
- Added content-branch selection to `repair_migration_plain_text`, preserving
  dry-run defaults and forwarding the version to the REST query.
- Added an initial customer-owned Git publishing pilot and an independently
  buildable, frozen HTML-site export. CMS publishing integration, full block
  and module exports, and customer media migration remain under development.

## MCP 0.43.4 / Core 0.1.12

- Made fallback-host provisioning idempotently repairable by resubmitting the
  current site slug when its Pages project or DNS coordinates are missing.
- Made the permanent E2E site domain-neutral, preserved its provisioned hosting
  across reseeds, and required the Cloud qualification journey to repair and
  verify its exact fallback origin before publishing.

## MCP 0.43.3 / Core 0.1.11

- Hosted static site builds now add a host-scoped `X-Robots-Tag` rule for the
  platform fallback namespace through Cloudflare Pages `_headers`. Customer
  domains remain indexable, DNS-only fallback CNAMEs remain supported, and no
  zone-wide Transform Rule or Pages Function is required.

## MCP 0.43.2 / Core 0.1.10

- Self-host runtime convergence now routes all traffic to each newly deployed
  Cloud Run revision, including installations whose previous serving revision
  retained a release tag.

## MCP 0.43.1 / Core 0.1.9

- Added site-wide noindex configuration and indexing diagnostics across the
  settings UI, v1 API, MCP, previews, builds, and migration checks.
- Added a fail-closed migration launch report with URL, SEO, extension, form,
  provider, deployment, and indexing evidence.
- Rejected inert top-level responsive block data recursively and restored the
  native cookie-consent banner in hosted previews.
- Serialized Core, MCP, public documentation, and immutable manifest
  publication into one ordered OSS release train.

## MCP 0.43.0 / Core 0.1.8

- Added exact typed context bindings for native text, URL, image, file, and
  email block fields, plus field-aware collection body, image, and date blocks.
- Added server-rendered page/item breadcrumbs and heading outlines with stable
  IDs, explicit item-navigation field overrides, and stronger responsive,
  focus, overflow, and empty-state defaults.
- Bundled nested `style_overrides.custom_css` consistently in previews and
  static builds.
- Added native article/checklist collection presets to the portal, v1 API, and
  MCP, with blocks-first documentation.
- Page PATCH and batch-write now reject `content_mode` with a pointer to the
  revision-aware mode endpoint instead of silently ignoring it.
- Migration readiness can review proposed compositions and report native block,
  field, capability, business-specific, and workaround dependencies before any
  content is written.
- Added reusable native header, footer, and archive compositions with semantic
  navigation, responsive disclosure, configurable post-card field mappings,
  independent download actions, and omission of empty media markup.
- Added revision-safe partial mode switching and API/MCP access to native
  cookie-consent settings.
- Versioned previews now inherit block types, page templates, collections, and
  items from the base chain, show unresolved block dependencies visibly, and
  static builds fail instead of silently dropping an unknown block.
- Form shells now include transitive field-block styles, and responsive field
  objects are verified end-to-end while unsupported top-level responsive data
  is rejected explicitly.

## MCP 0.42.2 / Core 0.1.7

- Preserve every discovered trailing-slash spelling during migration URL
  verification, and emit slash-equivalent redirect variants in static builds
  without changing stored redirect rules.
- Normalize WordPress titles, excerpts, SEO text, and site metadata as plain
  text during new imports by decoding exactly one entity layer and removing
  markup.
- Add an authenticated, dry-run-first repair operation for legacy WordPress
  plain-text fields, with exact diffs, field and schema allowlists, working-copy
  conflict protection, and matching MCP guidance.

## MCP 0.42.1 / Core 0.1.6

- Replaced OAuth authorization JWTs with opaque, single-use codes and encrypted
  server-side grants. Codes issued before this update must be requested again;
  existing access and refresh tokens remain compatible.
- Restricted MCP media imports to public HTTP(S) destinations, with pinned DNS
  resolution, redirect validation, and bounded downloads.
- Reject sessions when Firebase revocation checks fail, including disabled or
  deleted accounts.
- Reserve unique site IDs atomically before provisioning to preserve existing
  sites when names collide.
- Reject replayed or concurrent form steps without changing completed submissions
  or repeating their actions.
- Repair organization claims when retrying an interrupted invitation acceptance.

## 0.42.0

- Added `typeroll extension configure` for API-key-authenticated installation
  config changes from an Extension repository.
- Extension config updates through the CLI and MCP now queue a production
  deploy by default, with explicit opt-outs for batching changes.
- Expanded the Extension documentation for installation config, labelled enum
  fields, preview route allowlists, secret preservation, and redeploy behavior.

## 0.41.1

- Fixed preview bridge origin binding behind TLS-terminating proxies and made
  bridge timeouts visible to Extension code instead of silently attempting a
  blocked iframe navigation.
- Documented that origin- or referrer-restricted third-party browser keys need
  a separate preview-safe configuration for the portal preview origin.

## 0.41.0

- Added `context.site.url()` and `context.site.navigate()` so Extension flows
  can move between site pages without escaping a signed preview.
- Added installation-scoped `context.storage.session` and
  `context.storage.local`. Published sites use Web Storage; opaque preview
  frames use a source-bound parent bridge with tab-session lifetime, keeping
  private handoff data out of URLs, referrers, generated HTML, and requests.
- Added explicit site-navigation and storage capability flags.

## 0.40.1

- Fixed `<x-extension>` expansion inside HTML header and footer partials,
  including the 404 build path and cache key that previously allowed raw
  directives to reach deployed output.
- Added a dedicated capability flag for Extension directives in HTML partials.

## 0.40.0

- Added authenticated REST and MCP operations for reading and updating
  Extension installation config, with an explicit redeploy-required result.
- Added migration inventory imports, URL verification, internal-link checks,
  safer batch operations, and the corresponding MCP tools and skills.

## 0.39.0

- Added safe navigable Extension previews with short-lived preview proofs and
  route-level `preview_methods` allowlists enforced by both runtime and
  provider contracts.
- Added localized `enum_labels`, richer nested prop editing, URL pickers, and
  more precise site capability discovery.

## 0.38.0

- Standardized the product and protocol name on **Extensions**. Manifest
  schema v3, runtime 0.38 and host protocol 3 replace the short-lived
  Connector terminology with `ExtensionInstallation`, `public_extension` and
  `X-Typeroll-Extension-Token` throughout the public contract.

## 0.37.0

- Replaced the Extension gateway with the manifest v2 direct provider API
  contract. Browser components call developer-owned backends directly and can
  attach a short-lived, origin-bound installation JWT without proxying payloads
  through Typeroll or customer hosting.
- Kept customer site deployments static: Extension, Forms and Directory calls
  no longer generate Cloudflare Pages Functions. Forms use the owning hosted or
  self-hosted Forms endpoint directly.
- Defined Typeroll Apps as the separately sold premium collection operated
  only in Typeroll-controlled accounts, including for self-hosted CMS users;
  third-party and bespoke backends remain in their developers' accounts.
- Moved hosted fallback-domain indexing protection out of customer deploys and
  into a single `*.sites.typeroll.com` zone-level edge rule.

## 0.36.0

- Added least-privilege Extension form bindings and the
  `context.forms.submit()` runtime capability for native lead tools.
- Extension assets remain hash-pinned and are vendored under the customer
  domain; bound form submissions use a narrow same-origin proxy that does not
  forward customer cookies or authorization.

## 0.35.0

- Added the Typeroll Extension platform for private, unlisted and reviewed
  public extensions: immutable manifests, scoped installations, developer and
  site-admin surfaces, delegated admin SSO, lifecycle events and diagnostics.
- Added hash-pinned bundled components and sandboxed embedded apps, including
  opaque-origin editor preview, public build snapshots and a Cloudflare Pages
  gateway adapter with signed installation assertions.
- Added declared URL context and per-mount memory navigation for recipient
  links, plus server-expanded `<x-extension>` references for HTML-mode pages.
- Added self-hosted issuer discovery/JWKS and explicit provider trust pairing.
- Added the `typeroll extension` developer CLI for validation, draft push,
  test installation and promotion through the same APIs as the portal.

## 0.34.0

- Added server-expanded `<x-form id="…" />` references for HTML-mode pages;
  they use the same signed form shell and initial state as `core/form` blocks.
- Added a portal field builder for ordinary single-step forms and a native URL
  field block.
- Added admin-only, allowlisted form webhooks with encrypted signing secrets,
  HMAC/idempotency headers, transient retries, and delivery status in the
  submissions inbox.
- Wired pre-submit action vetoes into the standard stored-submission pipeline
  and removed admin action configuration from agent APIs and build snapshots.

## 0.33.0

- Added the opt-in Funnel attribution app: validated allowlisted query
  forwarding to exact HTTPS link targets, non-blocking analytics events, and
  optional consent-gated first-/last-touch cookies.
- Added admin UI, bearer API, and MCP configuration surfaces for funnel rules.
- Added private DevGlow + Tailscale Serve development instructions.

Notable changes to the Typeroll platform and the `@typeroll/mcp-server` npm
package, which are versioned together — the platform's
`template_capabilities_version` always matches the published npm version, so an
agent can call `get_site_capabilities` and know exactly what a deployment
supports.

Entries focus on what changes for **users, agents, and self-hosters**: breaking
changes first, then what's new, then fixes worth knowing about. Internal
refactors are omitted unless they alter observable behaviour.

Versions before 0.29.0 predate this file; see the git history and the
`mcp-v*` tags.

---

## 0.32.0 — unreleased

Migration tooling for moving a whole family of sites — a WordPress multisite,
or a set of country/language domains — without losing URLs, plus the hreflang
field that a multi-domain family needs.

### Added

**The URL inventory is reachable over the API and MCP.** The legacy-URL
inventory and its coverage analyser existed since the WordPress migration
shipped, but only behind the cookie-authed portal dashboard, and only the
migration workflow could populate it. Both limits are gone:

- `GET /api/v1/sites/{id}/migration-urls` — the inventory with a **live**
  coverage status per entry (`migrated` / `redirected` / `excluded` /
  `unhandled`), recomputed from current pages + redirects on every read.
  Filterable by status; the summary always describes the whole inventory, not
  the page you asked for.
- `POST /api/v1/sites/{id}/migration-urls` — bulk add (up to 2000 per call)
  from a sitemap walk, a Search Console export (pass `gsc_clicks` and the work
  list prioritises itself), or a crawl. Idempotent. `source_origin` rejects
  foreign-origin URLs, which is what stops one market's `/kontakt` registering
  as another market's coverage in a multi-domain migration — rejects are
  reported, never silent.
- `PATCH` / `DELETE /api/v1/sites/{id}/migration-urls/{urlId}` — `excluded` is
  the record that a URL is *meant* to 404, which is what separates "not looked
  at" from "decided".
- MCP: `list_migration_urls`, `add_migration_urls`, `update_migration_url`,
  `delete_migration_url`.

**Pre-cutover URL parity check.** Coverage analysis is a claim about the data;
this is a measurement of the server. `POST /api/v1/sites/{id}/migration-urls/verify`
(MCP: `verify_migration_urls`, or the new **URL parity check** workflow in the
portal) requests every inventory URL against the deployed site and classifies
what came back: `ok`, `ok_redirect`, `missing`, `broken_redirect`, `error`. It
catches what coverage cannot — a redirect pointing at an unpublished page, a
typo'd `path`, a redirect loop — all of which read as handled in the report and
as a 404 to Googlebot.

It runs against the site's **fallback subdomain** by default, i.e. while the
real domain still points at the old host. That's the point: find and close the
gaps with the old site still serving, then move DNS.

Redirect rules exercised by a run get `verified` + `last_checked` stamped on
them. Those two fields have been in the data model since redirects shipped and
nothing wrote them.

**`Page.alternates` — hreflang for cross-domain language clusters.** A Typeroll
site owns one domain, so `example.se` / `example.de` / `example.co.uk` is three
sites and nothing can derive which page matches which. Declare it per page and
the renderer emits `<link rel="alternate" hreflang>` in `<head>`, injecting the
page's own self-reference (Google drops clusters whose members don't list
themselves). Writable from v1 REST (`create_page`, `PATCH`/`PUT`, `batch-write`)
and MCP (`create_page`, `update_page`). Invalid tags or non-absolute hrefs are
**rejected at write time with the reason** rather than dropped silently at
render. Capability flag: `supports_hreflang_alternates`.

**`tr-migrate-multisite` skill** — the recipe for the whole job: one site per
domain, per-site inventory before any building, one reference site approved
then replicated via `.tcblocks`, path preservation, redirects, hreflang written
on all sides, and the parity check as the gate on cutover.

**Migration preflight.** `GET /api/v1/sites/{id}/migration-preflight` (MCP:
`get_migration_readiness`) answers "is this site ready to receive an import?"
before any content moves, and the in-portal migration workflow now runs the
same check as its **first step** and refuses to start when a blocker stands
(`skip_preflight: true` overrides, and logs that it did).

Every check exists because its failure is invisible after the fact — the
import succeeds, previews render, the customer signs off:

- **Media storage (blocker).** Without R2 configured, imported pages keep
  their original image URLs: the new site looks perfect and is still served
  images by the old host. Nothing appears broken until that hosting is
  cancelled, months later, when every image breaks at once.
- **Hosting adapter (blocker).** Without Cloudflare credentials, deploys run
  against the stub adapter — a job id, no publish, and a green result.
- **Source site (blocker, when you name one).** Pass `source_url` and the site
  being migrated FROM is probed too: unreachable, or 403/429 from bot
  protection, blocks — an import from a host that refuses our requests
  produces empty pages, or pages containing the block page, which reads as
  real content. Whether `/wp-json` answers is a warning, since the importer
  can fall back to scraping (losing ACF/custom fields).
- Warnings for the pre-cutover verification URL, AI reconstruction, form
  notification email (only once the site actually has a form), and whether the
  target carries a design for the content to be rebuilt into.

The migration dashboard shows the report above the coverage table, because a
blocker invalidates the numbers below it: a site can reach 100% URL coverage
while still serving every image from the host it is migrating away from.

**Redirect wildcards.** `from_path` accepts a trailing `*` (with `:splat` in
the target) and `:name` placeholders matching one segment, so a WordPress
migration retires whole URL families in one rule each —
`/category/*` → `/blogg/:splat` — instead of one rule per URL the inventory
happened to find. Available from the portal's redirect form, v1 REST, MCP
(`create_redirect`) and the chat AI.

Three refusals, all at write time rather than in production:

- a `*` anywhere but the end (Cloudflare drops such a line silently, so the
  rule would read as saved and do nothing);
- `:splat`/`:name` in a target that `from_path` doesn't declare;
- **any rule that would hide a live page**, naming the pages it would hide.
  Redirects are applied before static files, so `/blogg/*` makes every real
  article under `/blogg/` unreachable. The deploy keeps its belt-and-braces
  drop for pages published after the rule was written.

`_redirects` is now emitted most-specific-first, so `/blogg/recept/*` and
`/blogg/*` coexist with the narrower rule winning, and the coverage report
counts pattern-covered URLs as `redirected` — the same order production uses.
Query strings still can't be matched: `_redirects` keys on the path, so an old
`/?p=123` URL has to be handled at the source. Capability flag:
`supports_redirect_wildcards`.

### Fixed

- `og:locale` now follows a page's `language` override instead of always using
  the site default — it already diverged from `<html lang>`, which honoured the
  page.

---

## 0.31.0 — unreleased

Ships the directory app and the platform primitives under it, plus the
`Site.status` removal and build-cost accounting that were staged as 0.30.0.
**0.30.0 was never published** — it was folded in here rather than released
separately, so npm goes 0.29.0 → 0.31.0.

### Breaking

**`Site.status` is removed.** The field was a site lifecycle label
(`'planning' | 'migrating' | 'staging' | 'live' | 'paused'`) that was written
once when a site was created and never advanced afterwards. `'live'`,
`'staging'` and `'paused'` were unreachable in practice, so every site
reported `'planning'` forever — including sites serving production traffic on
a verified custom domain.

- **REST API:** `POST /api/v1/sites` no longer returns `status` in the created
  site object. `GET /api/v1/sites` and `GET /api/v1/sites/{id}` never included
  it, so they are unaffected.
- **MCP:** no tool ever exposed the field. Agents need no changes.
- **Stored data:** existing Firestore documents keep the field. Nothing reads
  it; no migration is required.

**What to use instead.** For "is this site actually serving?", read
`domain_status` (maintained by the domain lifecycle) or the `urls.production`
value from `get_site` — non-null means the domain is verified and serving. For
"has anything been published?", read the deploy history via `list_deploys`.

The portal now shows a domain-derived badge everywhere the old status appeared
(dashboard site cards, site overview, site switcher):

| Badge | Meaning |
| --- | --- |
| `live` | `domain_status` is `verified` or `live` — the site answers on its own domain |
| `DNS pending` | a domain is set, but DNS isn't confirmed yet |
| `DNS failed` | the DNS check failed — previously hidden |
| `no domain` | no custom domain set; the site serves on its Typeroll subdomain |

### Added

**Build-cost accounting.** Every deploy now records what the build cost the
platform to run, on the deploy job itself. `get_deploy_status` returns a `cost`
object with the total, a CPU/memory/request breakdown, wall-clock duration,
per-phase timings, and the size of the generated site. Failed builds are costed
too — they consume the same compute as successful ones.

Costs are **estimates** computed from a configurable rate card, not billing
records, and they are gross: free-tier allowances and committed-use discounts
are not deducted. Self-hosters can retune or zero out the rates with the
`DEPLOY_COST_*` environment variables — see
[Self-Hosting](https://typeroll.com/docs/guides/self-hosting/).

### Added — the directory app

A directory site is a collection with per-item routes, listing pages and
taxonomy pages, where the businesses listed can maintain their own entries.
Most of what landed is general platform machinery the directory is simply the
first consumer of.

- **One-time edit links.** A listing owner requests a link, receives it at the
  address already on their listing, and edits their own entry — no account, no
  password. The link works once and expires.
- **Per-field write authority + provenance.** `writable_by` decides who may
  write a field; provenance decides who wins when several may
  (`portal > owner > app > agent > import`). A refused write is a **409 naming
  the losing fields**, never a silent no-op — a silent drop makes an agent
  retry forever.
- **Item references and computed backlinks** — forward stored, reverse derived.
- **Taxonomy pages** with a `min_items` guard, and combination pages
  enumerated explicitly rather than as a cartesian product. The limit that
  bites on a directory build is route count, not record count.
- **Completeness report** (`collection_completeness`) — the entry point for an
  agent-directed enrichment pass.
- **`core/embed`** — per-page JavaScript with a declared home, so the
  sanitizer never has to be the way in.
- **Integrations app** — 20 third-party tags configured from validated IDs
  rather than pasted script blobs.
- **Apps can ship forms and blocks**; form actions and prefill compose across
  sources.
- **Org member roles are enforced** (`MemberRole`), opt-in per org via
  `Organization.roles_enforced`.
- **Coalesced auto-deploy**, opt-in per site via `Site.auto_deploy.enabled`,
  debounced (15 min default) and folded into the existing publish sweep rather
  than a second scheduler.

Both new flags default to **off**, so nothing changes for existing sites on
upgrade.

### Security

- **Preview responses that render customer HTML on the portal origin are now
  sandboxed** into an opaque origin (`Content-Security-Policy: sandbox`
  without `allow-same-origin`). The sanitizer already strips `<script>`; this
  is defence in depth, because a sanitizer bypass on that origin would be a
  session compromise rather than a defaced preview. The editor's own iframe
  routes are a documented exception — they need same-origin DOM access — and
  the editor canvas does not execute block JavaScript.
- **Executable block-instance fields are gated** behind
  `BlockType.script_fields`.

---

## 0.29.0 — 2026-07-25

### Breaking

**Forms are steps-only.** Form definitions are now stored as `steps[]`. The
Forms 1.0 flat `fields[]` array is gone as a storage shape, but remains
accepted on write as sugar — passing `fields` still creates a single-step form,
so existing agent prompts keep working. Reads always return `steps`.

### Added

- **Typeroll apps** — an opt-in per-site extension framework, with privacy-
  friendly **Analytics** as the first app (Cloudflare Web Analytics, including
  a breakdown of visits arriving from AI assistants). Off by default; enabled
  per site by an admin in the portal under Settings → Apps.
- **Site search** — the `core/search` block indexes the built site with
  Pagefind at deploy time. Add the block and search works; no configuration.
- **Scheduled publishing** — `publish_at` / `unpublish_at` on pages and
  collection items, swept automatically, with a deploy triggered on change.
- **Archive pagination** — collections paginate to `/page/N/` routes.
- **`llms.txt`** — generated at build time so AI assistants can discover a
  site's structure and content.
- **Content export** — download a site's full content as JSON, from the portal
  or via API.
- **Editor** — inline on-canvas text editing, undo/redo (`⌘Z` / `⇧⌘Z`), block
  duplication (`⌘D`), and a visual review of unsaved changes before saving.
- **`core/feature_row`** — a gutter-hugging image + text section block.
- **Media integrity validation** at finalize (SHA-256 verification and a guard
  against truncated SVG uploads).

### Fixed

- **Scripted blocks were dead on deployed sites.** The block runtime's
  initialisation selector was never stamped onto the rendered markup, so custom
  block JavaScript ran in the editor preview but never on the published site.
