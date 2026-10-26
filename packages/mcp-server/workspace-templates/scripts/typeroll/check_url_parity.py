"""Read-only URL continuity check on an explicitly supplied deployed origin."""
import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
import trlib

UA = 'Typeroll-Starter-QA/1.0 (+https://typeroll.com/docs/)'


def fetch(url, method='GET'):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': UA})
    for attempt in range(2):
        try:
            with urllib.request.build_opener(trlib.NoRedirect).open(request, timeout=30) as response:
                return response.status, response.headers.get('Location'), response.read() if method == 'GET' else b''
        except urllib.error.HTTPError as error:
            if error.code in (502, 503, 504) and attempt == 0:
                continue
            return error.code, error.headers.get('Location'), b''
        except (OSError, TimeoutError):
            if attempt:
                return 0, None, b''


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Supply a plain deployed HTTP(S) origin')
    return value.rstrip('/')


def probe(url, expected_page=False):
    initial, seen, hops = url, set(), []
    for _ in range(6):
        if url in seen:
            return {'error': 'redirect_loop', 'hops': hops}
        seen.add(url)
        status, location, _ = fetch(url)
        if status not in (301, 302, 303, 307, 308) or not location:
            slash = bool(hops) and urllib.parse.urlsplit(initial)._replace(path=urllib.parse.urlsplit(initial).path.rstrip('/')) == urllib.parse.urlsplit(hops[0])._replace(path=urllib.parse.urlsplit(hops[0]).path.rstrip('/'))
            maximum = 1 if expected_page else 2 if slash else 1
            acceptable_page_hop = not expected_page or not hops or (len(hops) == 1 and slash)
            ok = status == 200 and len(hops) <= maximum and acceptable_page_hop
            return {'ok': ok, 'status': status, 'hops': hops, 'final_url': url}
        url = urllib.parse.urljoin(url, location)
        if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
            return {'error': 'unsupported_redirect_scheme', 'hops': hops}
        hops.append(url)
    return {'error': 'too_many_redirects', 'hops': hops}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin', type=origin)
    parser.add_argument('--show-excluded', action='store_true')
    args = parser.parse_args()
    report = []
    for row in trlib.all_migration_urls():
        if row.get('status') == 'excluded' and not args.show_excluded:
            continue
        for path in sorted(set([row['path']] + (row.get('observed_paths') or []))):
            # Inventory spellings must be paths, not a silent change of tested host.
            if not path.startswith('/') or path.startswith('//'):
                raise ValueError('Inventory contains a non-local path')
            url = args.origin + urllib.parse.quote(path, safe='/%?=&:+')
            report.append({'path': path, **probe(url, row.get('status') == 'migrated')})
    print(json.dumps(report, indent=2))
    return 1 if not report or any(not row.get('ok') for row in report) else 0


if __name__ == '__main__':
    raise SystemExit(main())
