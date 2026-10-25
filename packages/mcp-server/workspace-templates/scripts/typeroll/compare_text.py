"""Compare saved source HTML (or one WP REST record) to a captured target.
Template titles are included exactly once by explicit source title/target selector.
This reports differences, never rewrites content or approves a migration.
"""
import argparse
import difflib
from html.parser import HTMLParser
import json
from pathlib import Path
import re


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.words, self.skip = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        elif tag in ('p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'h4'):
            self.words.append(' ')
    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        elif tag in ('p', 'div', 'li', 'h1', 'h2', 'h3', 'h4'):
            self.words.append(' ')
    def handle_data(self, value):
        if not self.skip:
            self.words.append(value)
    # HTMLParser excludes comments. Do not strip tags with a regexp.


def tokens(value):
    parser = Text()
    parser.feed(value)
    return re.findall(r'\w+|[^\w\s]', ''.join(parser.words))


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('source', help='HTML fragment or one saved WP REST record (.json)')
    args.add_argument('target', help='JSON from capture_text.cjs')
    args.add_argument('--source-title', default='', help='For an HTML source whose title is template-owned')
    opts = args.parse_args()
    source = Path(opts.source).read_text()
    if opts.source.endswith('.json'):
        record = json.loads(source)
        source = record['title']['rendered'] + ' ' + record['content']['rendered']
    else:
        source = opts.source_title + ' ' + source
    target = json.loads(Path(opts.target).read_text())
    before, after = tokens(source), re.findall(r'\w+|[^\w\s]', target['text'])
    changes = [line for line in difflib.ndiff(before, after) if line.startswith(('+ ', '- '))]
    print(json.dumps({'source_tokens': len(before), 'target_tokens': len(after), 'changes': changes}, ensure_ascii=False, indent=2))
    return int(bool(changes))


if __name__ == '__main__':
    raise SystemExit(main())
