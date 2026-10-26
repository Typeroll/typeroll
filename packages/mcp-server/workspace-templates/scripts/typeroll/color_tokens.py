"""Review exact colour-to-token replacements; never publish or edit CSS automatically.
Dry run: python3 scripts/typeroll/color_tokens.py --plan /tmp/design-token-plan.json
Apply:   python3 scripts/typeroll/color_tokens.py --apply /tmp/design-token-plan.json
Apply only on a dedicated non-main Version, with no other editors in that Version.
The plan contains paths and colour values, not page bodies. Keep it out of Git.
"""
import argparse
import hashlib
import json
from pathlib import Path
import trlib


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def snapshot():
    config = trlib.workspace()
    report = trlib.call('lint_design_tokens')
    if (report['site_id'], report['organization_id'], report['version_id']) != (
            config['site_id'], config['organization_id'], config['version']):
        raise ValueError('Audit scope does not match typeroll.json')
    settings = trlib.call('read_site_settings')['settings']
    return {'scope': {k: config[k] for k in ('portal', 'organization_id', 'site_id', 'version')},
            'palette_hash': digest(settings.get('colors', {})),
            'counts_before': report['counts'],
            'replacements': report['exact_replacements']}, report


def apply_plan(plan):
    current, report = snapshot()
    if plan['scope'] != current['scope'] or plan['palette_hash'] != current['palette_hash']:
        raise ValueError('Site, Version or palette changed. Run a new dry run; nothing was written.')
    if current['scope']['version'] == 'main':
        raise ValueError('Use a dedicated test Version, review it, then promote normally. main is not supported.')
    available = {digest(row) for row in current['replacements']}
    if any(digest(row) not in available for row in plan['replacements']):
        raise ValueError('A replacement is stale or was edited. Run a new dry run; nothing was written.')
    targets = {(r['target']['kind'], r['target']['id']) for r in plan['replacements']}
    for kind, id_ in targets:
        if kind != 'template' and trlib.call('read_working_copy', {'target': {'kind': kind, 'id': id_}}).get('working_copy'):
            raise ValueError(f'{kind}:{id_} has an unsaved draft; nothing was written.')
    applied = 0
    # Ordinary field patches preserve unrelated data. No retries after uncertain writes.
    # There is no site-wide lock: stop concurrent editing while this command runs.
    for row in plan['replacements']:
        tree = trlib.call('get_page_blocks', {'target': row['target']})
        block = next((b for b in trlib.walk(tree['blocks']) if b['id'] == row['block_id']), None)
        if block is None or block.get('data', {}).get(row['field']) != row['before']:
            raise ValueError(f"Source changed after {applied} replacements. Inspect drafts and run a new dry run.")
        trlib.call('update_block', {'target': row['target'], 'block_id': row['block_id'], 'data': {row['field']: row['after']}})
        applied += 1
    for kind, id_ in targets:
        if kind != 'template':
            trlib.call('commit_working_copy', {'target': {'kind': kind, 'id': id_}})
    after = trlib.call('lint_design_tokens')
    print(json.dumps({'applied': applied, 'before': plan['counts_before'], 'after': after['counts'],
                      'published': False, 'next': 'Review preview at all breakpoints before promotion.'}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', type=Path)
    mode.add_argument('--apply', type=Path)
    args = parser.parse_args()
    if args.apply:
        apply_plan(json.loads(args.apply.read_text()))
    else:
        plan, report = snapshot()
        args.plan.write_text(json.dumps(plan, indent=2) + '\n')
        args.plan.chmod(0o600)
        print(json.dumps({'counts': report['counts'], 'proposed_replacements': len(plan['replacements']),
                          'simulated_color_count_after': report['counts']['hardcoded_color'] - len(plan['replacements']),
                          'written': False, 'plan': str(args.plan),
                          'note': 'Review and remove deliberate exceptions from the plan. Ambiguous roles, nested values and CSS require manual review.'}, indent=2))


if __name__ == '__main__':
    main()
