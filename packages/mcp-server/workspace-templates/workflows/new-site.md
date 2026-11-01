# New website kickoff

Use this prompt only when the brief is already clear. Otherwise start or resume
workflows/interview.md; the owner does not need to fill in every document alone.

```text
Create [website] for [audience and purpose] in Typeroll Organization [ID/name].
Read AGENTS.md, confirm the Site and Version, and use workflows/interview.md for
missing decisions. Record confirmed goals, brand, content model, owner rules and
SEO strategy in brief/. Agree the page plan in brief/content-model.md before
design work, and ask for the launch basics in brief/seo.md. Read tr-new-site
and relevant tool schemas on demand.
Build representative desktop/mobile layouts with editable blocks and shared templates.
Share previews, record accepted decisions and keep unresolved items explicit.
Do not publish, change DNS or send messages without explicit approval.
```

The CMS owns current content and settings. The repository owns the brief, rules,
decisions and evidence. Load recipes when needed, not the whole manual.

## Design token check

Follow workflows/design.md for palette/font roles and named scales. Run
`lint_design_tokens` before launch and after major design changes. Review exact
colour replacements with scripts/typeroll/color_tokens.py; record deliberate
exceptions in decisions.md. Preserve text independently from design changes.

## Launch

Before the first production publication and again after it, follow the Launch
section of qa/checklist.md: run `read_site_readiness`, fix or record each open
item, and save the result in qa/. The report warns and never blocks; publishing
still needs the owner's approval.
