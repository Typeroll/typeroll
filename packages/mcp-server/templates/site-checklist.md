# Site checklist — definition of done

The site kit copies this into `checklist.md`. Check an item only after verifying
it. Record intentional exceptions and their reason in `build-log.md`.

## Setup

- [ ] Site settings, language, contact details, colors and fonts match the brief.
- [ ] Logo, favicon and touch icon are uploaded and used by the site.
- [ ] Header and footer are reusable partials and work on mobile.

## Content model

- [ ] Every article, checklist, directory entry and ordinary page is a Page.
- [ ] Content types define only custom fields, routes and default Page templates.
- [ ] Common title, slug, path, body, SEO and status are Page properties.
- [ ] New body content uses native editable blocks; rare HTML exceptions are named.
- [ ] Templates contain a `template_content_slot` for each Page's body.
- [ ] Page references use Page IDs; reference order and missing references are checked.
- [ ] The same `version` is used for Page, type, template and preview operations.
- [ ] Existing site data is migrated before running Core 0.2.0; no runtime aliases.

## Optional owner answers (next coordinated release)

- [ ] Owner answers distinguish Yes, No and unanswered; unchanged prefill is not confirmed.
- [ ] Structured repeated answers have stable item identities and source evidence.
- [ ] Owner proposals remain outside accepted Pages until explicit review.
- [ ] Review configuration, notification recovery and normal publication are tested separately.
- [ ] No live authentication, email, schema migration or publishing is enabled without authorization.

## Content and SEO

- [ ] Approved copy and all expected Pages are present, including every content type.
- [ ] Images have appropriate alt text; Forms are configured and embedded.
- [ ] Internal links, navigation, canonicals, redirects and paths are verified.
- [ ] Each Page has a title, description and suitable social image.
- [ ] Language, structured data, robots rules and sitemaps are correct.

## Quality

- [ ] Desktop and mobile previews show every section and usable navigation.
- [ ] Heading hierarchy, contrast and responsive layout have been checked.
- [ ] Media preparation is ready; images and variants have suitable sizes.
- [ ] Type changes preserve Page body, identity and path; new required fields are filled.
- [ ] Saved content and working copies are distinguished; only saved content deploys.

## Launch

- [ ] Customer storage and publishing prerequisites are verified.
- [ ] Deploy to the configured test address within the user's authorized scope.
- [ ] Check the compiled site without a Typeroll login, including images and downloads.
- [ ] No internal authenticated media address remains in public output.
- [ ] Test Forms submission, confirmation and inbox in the authorized environment.
- [ ] Prepare and verify final site/media hosts before traffic DNS changes.
- [ ] Check relevant hostnames after DNS cutover.

## Handoff

- [ ] Record decisions, verified URLs and remaining issues in `build-log.md`.
- [ ] Keep incomplete or skipped checks visible; do not report them as passed.
