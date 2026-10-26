# Internal Page notes

Keep internal sources, decisions, comments and dated history in this repository,
not in public CMS fields. The CMS remains the source of current content; notes
are editorial context, never a second content copy. Keep this workspace private
if notes contain private information. Never put credentials or signed URLs here.
Do not include pages/ in static output, content imports or public source bundles.

One file per stable Page ID: pages/<encoded-page-id>.md. The helper percent-encodes
IDs that contain path characters. URLs and titles can change without renaming notes.
Use a separate workspace/Git branch for another Site or Version; the generated
facts are bound to portal, Organization, Site and Version and reject mismatches.

Each note has review, next_review (YYYY-MM or YYYY-MM-DD), last_checked and
responsible metadata, followed by Purpose, Sources (including date and whether an
owner statement), Publishing considerations, Open questions and Log. Use dated
change, decision, comment and check entries; keep the newest first. Site-wide
rules belong in decisions.md, referenced from the relevant notes.

Choose a review cadence for the project, for example quarterly, annual, event-led
or when source facts change. There is no default season or automatic review date.
Refreshing facts never changes last_checked or next_review. Set those only after
an actual review. index.md sorts scheduled reviews first, then unscheduled Pages.

The generated block contains saved CMS metadata and candidate links from the saved
body. It does not inspect template/partial links, JavaScript or final rendering;
query-bearing URLs are omitted to avoid copying credentials. Check the rendered
Page and every external link during review. Sources, historical import statistics
and their dates belong in the human sections, not invented by the script.

Run scripts/typeroll/page_notes.py --dry-run, inspect, then omit --dry-run to refresh.
--migration-inventory optionally includes recorded redirect sources. Run from the
workspace root with a privately injected TYPEROLL_API_KEY. No CMS writes occur.
Only the generated markers and index.md are refreshed; malformed markers fail
without overwriting notes. Reconcile existing notes manually before adopting the
new marker/scope format; do not replace an established project's editorial history.

Notes without a Page are reported, never deleted automatically. Confirm deletion
and any redirect, add a final log entry, then move the note to pages/archived/.
Do not archive just because an API call failed or access changed.
