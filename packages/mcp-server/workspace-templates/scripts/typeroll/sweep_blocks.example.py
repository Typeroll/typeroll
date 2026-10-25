"""Pattern: change one kind of block on every Page, Page template and partial, then save.
Example: set last_row "start" on every core/grid that centers its last row. Dry run lists; --apply writes.
Copy and edit MATCH/PATCH for other sweeps. Templates save immediately; Pages and partials must be committed. Refuses existing unsaved work."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trlib
SITE = trlib.site_id()
MATCH = lambda b: b.get("type") == "core/grid" and (b.get("data") or {}).get("last_row") == "center"
PATCH = {"last_row": "start"}
apply = "--apply" in sys.argv
for tgt in trlib.containers():
    tree = trlib.call("get_page_blocks", {"site_id": SITE, "target": tgt})
    hits = [b for b in trlib.walk(tree.get("blocks", tree) if isinstance(tree, dict) else tree) if MATCH(b)]
    if not hits:
        continue
    print(tgt["kind"], tgt["id"], len(hits))
    if apply:
        if tgt['kind'] != 'template' and trlib.call('read_working_copy', {'target': tgt}).get('working_copy'):
            raise RuntimeError('Unsaved work exists; review it before this sweep')
        for b in hits:
            trlib.call("update_block", {"site_id": SITE, "target": tgt, "block_id": b["id"], "data": PATCH})
        if tgt["kind"] in ("page", "partial"):
            trlib.call("commit_working_copy", {"site_id": SITE, "target": tgt})
