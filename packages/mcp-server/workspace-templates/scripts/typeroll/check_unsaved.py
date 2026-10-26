"""Pre-deploy gate: list every Page and partial with an unsaved working copy (Page templates save immediately).
Deploys build saved content only, and previews with include_working_copy hide the difference.
usage: python3 scripts/typeroll/check_unsaved.py   (exit 1 when something is unsaved)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trlib
SITE = trlib.site_id()
bad = [t for t in trlib.containers() if t["kind"] != "template"
       and trlib.call("read_working_copy", {"site_id": SITE, "target": t}).get("working_copy")]
for t in bad:
    print("unsaved:", t["kind"], t["id"])
print("unsaved total:", len(bad))
sys.exit(1 if bad else 0)
