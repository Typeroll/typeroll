"""Small, version-bound MCP helper. Credentials are injected, never persisted.
No automatic retries for mutations. Run from the workspace root.
"""
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward Authorization or signed PUTs to another URL.


def workspace():
    for directory in (Path.cwd(), *Path.cwd().parents):
        file = directory / 'typeroll.json'
        if file.is_file():
            value = json.loads(file.read_text())
            if not all(value.get(k) for k in ('portal', 'organization_id', 'site_id', 'version')):
                raise ValueError('Complete portal, organization_id, site_id and version in typeroll.json first')
            origin = urllib.parse.urlsplit(value['portal'])
            if origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('', '/'):
                raise ValueError('portal must be a plain origin')
            if origin.scheme != 'https' and not (origin.scheme == 'http' and origin.hostname in ('localhost', '127.0.0.1', '::1')):
                raise ValueError('portal requires HTTPS (HTTP is allowed only on loopback)')
            return value
    raise ValueError('Run from a workspace containing typeroll.json')


class Client:
    def __init__(self, config=None):
        self.config = config or workspace()
        self.url = self.config['portal'].rstrip('/') + '/api/mcp?tools=full'
        self.session = None
        self.sequence = 0
        self.tools = None
        self.verified = False
        self.opener = urllib.request.build_opener(NoRedirect)

    def rpc(self, method, params=None, notify=False):
        self.sequence += 1
        body = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            body['params'] = params
        if not notify:
            body['id'] = self.sequence
        key = os.environ.get('TYPEROLL_API_KEY')
        if not key:
            raise ValueError('Inject TYPEROLL_API_KEY privately before running')
        headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                   'Accept': 'application/json, text/event-stream'}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers)
        try:
            with self.opener.open(request, timeout=180) as response:
                self.session = response.headers.get('Mcp-Session-Id') or self.session
                raw = response.read().decode()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'MCP HTTP {error.code}; no mutation was retried') from None
        if notify:
            return None
        result = decode_rpc(raw, self.sequence)
        if 'error' in result:
            raise RuntimeError(f"MCP RPC error {result['error'].get('code')}")
        return result['result']

    def initialize(self):
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                              'clientInfo': {'name': 'typeroll-workspace', 'version': '1'}})
        self.rpc('notifications/initialized', notify=True)
        self.tools = {}
        cursor = None
        seen = set()
        while True:
            result = self.rpc('tools/list', {'cursor': cursor} if cursor else {})
            self.tools.update({t['name']: t for t in result['tools']})
            cursor = result.get('nextCursor')
            if not cursor:
                break
            if cursor in seen:
                raise RuntimeError('tools/list repeated its cursor')
            seen.add(cursor)

    def call(self, tool, args=None):
        if self.tools is None:
            self.initialize()
        if tool not in self.tools:
            raise ValueError(f'Tool unavailable: {tool}')
        if not self.verified:
            info = self.invoke('get_site', {})
            if info.get('organization_id') != self.config['organization_id'] or info.get('id') != self.config['site_id']:
                raise ValueError('Connected Organization/Site does not match typeroll.json; nothing was written')
            self.verified = True
        return self.invoke(tool, args or {})

    def invoke(self, tool, args):
        props = self.tools[tool]['inputSchema'].get('properties', {})
        data = dict(args)
        for key, wanted in [('site_id', self.config['site_id']), ('version', self.config['version'])]:
            if key in data and data[key] != wanted:
                raise ValueError(f'{key} differs from typeroll.json; change the binding explicitly')
            if key in props:
                data[key] = wanted
        if 'version' not in props and self.config['version'] != 'main' and tool != 'get_site':
            raise ValueError(f'{tool} has no version parameter; refusing an implicit main-version operation')
        result = self.rpc('tools/call', {'name': tool, 'arguments': data})
        if result.get('isError'):
            raise RuntimeError(f'{tool} failed; inspect through your authenticated MCP client (no retry)')
        if 'structuredContent' in result:
            return result['structuredContent']
        text = ''.join(c.get('text', '') for c in result.get('content', []) if c.get('type') == 'text')
        return json.loads(text)


def decode_rpc(raw, request_id):
    if raw.lstrip().startswith('{'):
        value = json.loads(raw)
        if value.get('id') != request_id:
            raise ValueError('MCP response did not contain the matching request ID')
        return value
    # Streamable HTTP may include notifications, multiline data, and keepalives.
    for event in raw.replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip() for line in event.splitlines() if line.startswith('data:'))
        if data:
            value = json.loads(data)
            if value.get('id') == request_id:
                return value
    raise ValueError('MCP response did not contain the matching request ID')


_client = None


def call(tool, args=None):
    global _client
    if _client is None:
        _client = Client()
    return _client.call(tool, args)


def site_id():
    return workspace()['site_id']


def walk(blocks):
    for block in blocks or []:
        yield block
        yield from walk(block.get('children'))
        for slot in block.get('slots') or []:
            yield from walk(slot)


def all_pages(full=False):
    cursor, seen = None, set()
    while True:
        args = {'limit': 200, **({'full': True} if full else {}), **({'cursor': cursor} if cursor else {})}
        result = call('list_pages', args)
        yield from result['pages']
        cursor = result.get('next_cursor')
        if not cursor:
            return
        if cursor in seen:
            raise RuntimeError('list_pages repeated its cursor')
        seen.add(cursor)


def all_migration_urls():
    offset = 0
    while True:
        result = call('list_migration_urls', {'limit': 1000, 'offset': offset})
        rows = result['urls']
        yield from rows
        offset += len(rows)
        if not rows or offset >= result.get('total_matching', float('inf')):
            return


def containers():
    for page in all_pages():
        yield {'kind': 'page', 'id': page['id']}
    for kind, tool, key in [('template', 'list_page_templates', 'templates'), ('partial', 'list_partials', 'partials')]:
        result = call(tool)
        rows = result if isinstance(result, list) else result.get(key, result.get('page_templates'))
        if not isinstance(rows, list):
            raise ValueError(f'Unexpected response from {tool}')
        for row in rows:
            yield {'kind': kind, 'id': row['id']}


def upload(file, content_type, alt=''):
    content = Path(file).read_bytes()
    sha = hashlib.sha256(content).hexdigest()
    mint = call('create_upload_url', {'filename': Path(file).name, 'content_type': content_type,
                                    'size': len(content), 'alt_text': alt})
    if urllib.parse.urlsplit(mint['upload_url']).scheme != 'https':
        raise ValueError('Signed upload must use HTTPS')
    request = urllib.request.Request(mint['upload_url'], data=content, method='PUT', headers={'Content-Type': content_type})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            response.read()
    except Exception:
        raise RuntimeError('Signed upload failed; URL withheld; no automatic retry') from None
    result = call('finalize_media', {'media_id': mint['media_id'], 'expected_sha256': sha})
    evidence = result.get('result', result)
    if evidence.get('sha256') != sha:
        raise ValueError('Finalize did not confirm the source SHA-256; do not reference this asset')
    return {'media_id': mint['media_id'], 'cdn_url': mint['cdn_url'], 'sha256': sha}
