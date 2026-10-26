# Page notes and editorial review

1. During migration or creation, create pages/<page-id>.md using pages/README.md.
   Record sources, preservation choices, owner decisions and open questions.
2. Before editing a Page, read its note and relevant decisions.md entries. Missing
   notes mean missing context, not permission to invent facts. Read current CMS
   content too; do not overwrite newer edits from repository snapshots.
3. After an authorized edit, append a dated change/decision/comment entry, update
   sources and open questions, and refresh generated facts with page_notes.py.
   Saving or refreshing is not editorial review and must not advance last_checked.
4. At each review, inspect the current rendered Page and follow every external
   link, including template links. Verify destination and relevance, not just HTTP
   status. Record redirects, failures and uncertain checks; propose corrections
   instead of inventing replacements. Record actual review date and next review.
5. For a confirmed removed Page, log deletion, replacement/redirect and archive
   location, then move its note into pages/archived/. Keep its history in Git.

Use index.md as a review queue; no scheduler or mail is enabled by this routine.
Publication and DNS changes still require their normal authorization. These notes
are repository-only; no new MCP Page-notes fields or portal storage are implied.
