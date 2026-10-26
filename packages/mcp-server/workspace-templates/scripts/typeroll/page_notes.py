"""Refresh repository-only Page facts; never edit CMS content or human notes.

Run from the workspace root. --dry-run previews local changes. Optional
--migration-inventory adds saved migration URL facts. Credentials use trlib.
"""
import argparse
from datetime import date
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import quote, urlsplit
import trlib

START = '<!-- generated:start (page_notes.py; do not edit by hand) -->'
END = '<!-- generated:end -->'


def filename(page_id):
    if not isinstance(page_id, str) or not page_id or page_id.lower() in ('readme', 'index', 'archived', '.', '..'):
        raise ValueError('Page ID is empty or conflicts with a reserved notes path')
    return quote(page_id, safe='-_') + '.md'


def cell(value):
    return str(value if value is not None else '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('|', '&#124;').replace('\n', ' ').replace('\r', ' ')


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = set()

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.urls.update(v for k, v in attrs if k == 'href' and v)


def body_links(page, blocks):
    parser = Links()
    parser.feed(page.get('html_content') or '')

    def visit(value, key=''):
        if isinstance(value, dict):
            for k, v in value.items():
                visit(v, k)
        elif isinstance(value, list):
            for v in value:
                visit(v, key)
        elif isinstance(value, str):
            if key in ('href', 'link', 'url', 'button_url', 'link_url'):
                parser.urls.add(value)
            if '<a' in value.lower():
                parser.feed(value)
    for block in trlib.walk(blocks):
        visit(block.get('data') or {})
    # Do not persist signed preview links or query credentials in repository notes.
    return sorted(u for u in parser.urls if not urlsplit(u).query and not urlsplit(u).username
                  and urlsplit(u).scheme in ('', 'http', 'https'))


def scope(config):
    return hashlib.sha256(json.dumps([config[k] for k in ('portal', 'organization_id', 'site_id', 'version')]).encode()).hexdigest()


def refresh(root, config, pages, links, migration=(), dry_run=False):
    """Read all inputs before writing. Preserve every byte outside owned markers."""
    out = root / 'pages'
    if out.is_symlink():
        raise ValueError('The notes directory must not be a symlink')
    names = [filename(p['id']) for p in pages]
    if len({n.lower() for n in names}) != len(names):
        raise ValueError('Page IDs collide on a case-insensitive filesystem')
    identity = '<!-- scope: ' + scope(config) + ' -->'
    planned, rows = {}, []
    for p, name in zip(pages, names):
        file = out / name
        if file.is_symlink():
            raise ValueError('A note must not be a symlink')
        text = file.read_text() if file.exists() else (
            '---\nreview: unset\nnext_review: \nlast_checked: \nresponsible: \n---\n\n# ' + cell(p['title']) + '\n\n'
            + START + '\n' + identity + '\n' + END
            + '\n\n## Purpose\n\nTODO\n\n## Sources\n\nTODO\n\n## Publishing considerations\n\nTODO\n\n'
              '## Open questions\n\n- Set a review cadence and next review date.\n\n## Log\n\n- '
            + date.today().isoformat() + ' · comment · Note created; editorial review has not been performed.\n')
        if text.count(START) != 1 or text.count(END) != 1 or text.index(START) >= text.index(END):
            raise ValueError('Missing or ambiguous generated markers in ' + name + '; reconcile manually')
        old = text.split(START)[1].split(END)[0]
        if identity not in old:
            raise ValueError('Note scope differs from the selected Organization/Site/Version: ' + name)
        facts = [START, identity, '', '| Fact | Value |', '| --- | --- |']
        for label, value in [('Page ID', p['id']), ('URL', p.get('url')), ('Title', p['title']),
                             ('Status', p.get('status')), ('Content type', p.get('content_type')),
                             ('Template', p.get('template')), ('Last saved', p.get('date_updated'))]:
            facts.append('| ' + label + ' | ' + cell(value) + ' |')
        aliases = [m['path'] for m in migration if m.get('status') == 'redirected' and m.get('target', '').rstrip('/') == p.get('url', '').rstrip('/')]
        if aliases:
            facts.append('| Recorded old URLs | ' + cell(', '.join(sorted(aliases))) + ' |')
        facts += ['', 'Saved body link candidates (not a complete rendered-link audit; query URLs omitted):', '']
        facts += ['- ' + cell(u) for u in links.get(p['id'], [])] or ['- None found.']
        facts += ['', END]
        new = text[:text.index(START)] + '\n'.join(facts) + text[text.index(END) + len(END):]
        if new != text:
            planned[file] = new
        elif not file.exists():
            planned[file] = new
        fm = dict(re.findall(r'^(review|next_review|last_checked|responsible):[ \t]*([^\n]*)', new.split('---', 2)[1], re.M)) if new.startswith('---\n') else {}
        nxt = fm.get('next_review', '').strip()
        if nxt and not re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?', nxt):
            raise ValueError('Use YYYY-MM or YYYY-MM-DD for next_review in ' + name)
        rows.append((nxt or '9999', name, '| ' + (nxt or 'Not scheduled') + ' | [' + cell(p['title']).replace('[', '&#91;').replace(']', '&#93;') + '](' + name + ') | ' + cell(fm.get('review', 'unset')) + ' | ' + cell(fm.get('last_checked', '')) + ' |'))
    index = out / 'index.md'
    if index.is_symlink():
        raise ValueError('The notes index must not be a symlink')
    index_text = '# Page notes index\n\nGenerated from local notes; dates are editorial decisions, not CMS save dates.\n\n| Next review | Page | Cadence | Last checked |\n| --- | --- | --- | --- |\n' + '\n'.join(r[2] for r in sorted(rows)) + '\n'
    if not index.exists() or index.read_text() != index_text:
        planned[index] = index_text
    orphans = sorted(f.name for f in out.glob('*.md') if f.name not in {*names, 'README.md', 'index.md'})
    if not dry_run:
        out.mkdir(parents=True, exist_ok=True)
        for file, text in planned.items():
            file.write_text(text)
    return {'changed': [str(f.relative_to(root)) for f in planned], 'notes_without_page': orphans, 'dry_run': dry_run}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--migration-inventory', action='store_true')
    args = parser.parse_args()
    root = Path.cwd()
    if not (root / 'typeroll.json').is_file():
        parser.error('Run from the workspace root containing typeroll.json')
    config = trlib.workspace()
    # list_pages(full=True) reads saved content, unlike read_page's draft overlay.
    pages = list(trlib.all_pages(full=True))
    links = {p['id']: body_links(p, p.get('blocks') or []) for p in pages}
    migration = list(trlib.all_migration_urls()) if args.migration_inventory else []
    print(json.dumps(refresh(root, config, pages, links, migration, args.dry_run), indent=2))


if __name__ == '__main__':
    main()
