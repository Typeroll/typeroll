"""Compare SEO and sharing metadata in two saved, rendered HTML documents.
Reports differences for review; does not rewrite content or approve exceptions.
Save full HTML, not body-only captures. Review migrated image URL differences
against the media mapping even when both images look the same.
"""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values, self.in_title = {}, False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self.in_title = True
            self.values.setdefault('title', []).append('')
        elif tag == 'meta':
            key = attrs.get('property', attrs.get('name', '')).lower()
            if key in ('description', 'robots') or key.startswith(('og:', 'twitter:')):
                self.values.setdefault(key, []).append(attrs.get('content', '').strip())
        elif tag == 'link' and attrs.get('rel', '').lower() == 'canonical':
            self.values.setdefault('canonical', []).append(attrs.get('href', ''))

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.values['title'][-1] += data


def compare(source, target):
    before, after = Metadata(), Metadata()
    before.feed(source)
    after.feed(target)
    return [{'field': key, 'source': before.values.get(key, []), 'target': after.values.get(key, [])}
            for key in sorted(before.values.keys() | after.values.keys())
            if before.values.get(key, []) != after.values.get(key, [])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Saved source HTML, including its head')
    parser.add_argument('target', help='Saved deployed target HTML, including its head')
    opts = parser.parse_args()
    differences = compare(Path(opts.source).read_text(), Path(opts.target).read_text())
    print(json.dumps({'differences': differences, 'requires_review': bool(differences)}, ensure_ascii=False, indent=2))
    return int(bool(differences))


if __name__ == '__main__':
    raise SystemExit(main())
