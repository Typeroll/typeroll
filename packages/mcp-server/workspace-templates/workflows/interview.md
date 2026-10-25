# Guided website interview

## When to start or resume

Use this routine when the owner asks for guidance or a material decision is missing
from the brief. Read the existing briefs, decisions and brief/interview.md first.
Do not restart an interview or ask questions already answered. If the brief is
complete, summarize it and continue with the relevant routine. This is an agent
conversation, not a portal wizard or a new API workflow.

## How to conduct it

- Use the owner's language. Ask one short question at a time; offer concrete
  choices and allow a free answer or "not sure". Explain technical choices plainly.
- Reuse explicit instructions already given. Distinguish confirmed answers,
  proposals and unknowns. Never treat silence as approval.
- If an answer is unknown, suggest an option with its consequences. Research and
  reversible prototypes may continue; do not perform dependent CMS writes until
  the necessary decision is confirmed.
- Save each answer and its source/date in brief/interview.md, and the approved
  decision in the relevant brief. Keep the next question and unresolved items so
  another session can resume. Do not store credentials, personal contact lists
  or raw private transcripts here. No MCP connection is needed to plan locally.
- Reopen only affected questions when the owner changes direction. Record the
  change in decisions.md; do not silently replace confirmed rules.

## Interview stages

1. **Goal and scope** — New website or migration? Purpose, audience, language,
   desired visitor actions, source URL and what is in/out of scope.
   Save to brief/site.md and brief/migration.md when relevant.
2. **Target and access** — Existing or new Typeroll Site? Discover accessible
   Organizations/Sites through MCP and confirm the exact target and Version before
   writes. Explain any missing storage or access when it becomes relevant; never
   ask for a secret in chat. Save non-secret IDs to typeroll.json only when known.
3. **Text decision (migration)** — Preserve existing wording or renew it?
   Preserve covers headings, body copy, CTA labels, captions and other authored
   text. Record SEO titles/descriptions, alt text, legal text, translation and any
   page-specific exceptions explicitly. Renewal needs an agreed editorial brief;
   it is not permission to invent facts. Save text_intent in brief/migration.md.
4. **Design and image decision (migration)** — Independently preserve or renew
   layout, typography, colors and imagery? Offer all four text/design combinations.
   For renewal, ask which existing assets must remain and which may be replaced
   or generated. Clarify cropping, logos, credits and image rights. Optimization
   alone must not change the motif. Save design_intent and asset exceptions in
   brief/migration.md, and the direction in brief/brand.md. A fresh design never
   grants permission to rewrite preserved text.
5. **Content and behavior** — Page types, shared templates, navigation, forms,
   downloads, integrations and who will edit them. Identify missing capabilities
   before scaling up. Save to brief/content-model.md. New websites skip migration
   preservation choices and establish their brand/content brief here.
6. **SEO and continuity** — Markets, search intent, useful topics and existing
   valuable URLs. Record evidence separately from hypotheses in brief/seo.md.
   Confirm metadata policy; text preservation cannot be bypassed as "SEO cleanup".
   Every old public URL must remain or redirect meaningfully regardless of the
   two migration choices. Retiring a URL requires a separate agreed exception.
7. **Owner rules and review** — Non-negotiable copy/design constraints, editing
   roles and who approves prototypes, publication, DNS or messages. Save confirmed
   rules to brief/rules.md. Keep technical access separate from user authorization.
8. **Recap and next action** — Show the scope, both migration decisions (if any),
   image exceptions, acceptance references, open questions and the next concrete
   step. Ask the owner to correct/confirm the brief before dependent writes.
   Reuse existing approval if it already covers that exact step. Brief approval
   alone does not authorize publication, domain cutover or mail.

## Completion

Mark the interview ready for the agreed next step only when its blocking questions
are answered; list deferred decisions explicitly. Continue with workflows/new-site.md
or workflows/migration.md and load only the relevant MCP recipe. Confirm one
prototype per distinct layout before bulk work. Review preserved dimensions
against the source and renewed dimensions against the approved brief separately.
