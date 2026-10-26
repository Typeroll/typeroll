"""Check published page assets, including relative URLs and srcset. CSS backgrounds need visual QA."""
import argparse
import concurrent.futures
from html.parser import HTMLParser
import json
import urllib.parse
import trlib
from check_url_parity import origin, fetch, probe


class Assets(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.urls = base, set()

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        values = []
        if tag in ('img', 'source', 'video', 'audio', 'script'):
            values.extend(data[k] for k in ('src', 'poster') if data.get(k))
        if tag == 'link' and data.get('rel') == 'stylesheet':
            values.append(data.get('href', ''))
        href = data.get('href', '')
        if tag == 'a' and ('download' in data or urllib.parse.urlsplit(href).path.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.svg', '.zip'))):
            values.append(href)
        if data.get('srcset') and not data['srcset'].strip().startswith('data:'):
            values.extend(item.strip().split()[0] for item in data['srcset'].split(',') if item.strip())
        for value in values:
            url = urllib.parse.urljoin(self.base, value)
            if urllib.parse.urlsplit(url).scheme in ('http', 'https'):
                self.urls.add(url)


def check(url):
    status, location, _ = fetch(url, 'HEAD')
    # HEAD is not supported everywhere; redirects must resolve too.
    if status in (405, 501) or location:
        status = probe(url).get('status', 0)
    return {'url': url, 'status': status, 'ok': status == 200}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin', type=origin)
    args = parser.parse_args()
    pages = [p for p in trlib.all_pages() if p.get('status') in ('published', 'unlisted')]
    errors, assets = [], set()
    for page in pages:
        if not page.get('url'):
            errors.append({'page_id': page['id'], 'error': 'missing_resolved_route'})
            continue
        route = urllib.parse.urlsplit(page['url'])
        url = args.origin + (route.path or '/') + ('?' + route.query if route.query else '')
        evidence = probe(url, expected_page=True)
        if not evidence.get('ok'):
            errors.append({'page_id': page['id'], **evidence})
            continue
        status, _, body = fetch(evidence['final_url'])
        if status != 200:
            errors.append({'page_id': page['id'], 'status': status})
            continue
        parser = Assets(evidence['final_url'])
        parser.feed(body.decode('utf8', 'replace'))
        assets.update(parser.urls)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(check, sorted(assets)))
    print(json.dumps({'pages': len(pages), 'page_errors': errors, 'assets': results}, indent=2))
    return 1 if not pages or errors or any(not item['ok'] for item in results) else 0


if __name__ == '__main__':
    raise SystemExit(main())
