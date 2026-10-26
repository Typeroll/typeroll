"""Synthetic tests: no customer requests or real credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'packages/mcp-server/workspace-templates/scripts/typeroll'
sys.path.insert(0, str(ROOT))
import trlib
import color_tokens
import check_url_parity as parity
from check_assets import Assets
from compare_text import tokens

CONFIG = {'portal': 'https://cms.example.test', 'organization_id': 'org', 'site_id': 'site', 'version': 'review'}


class QA(unittest.TestCase):
    def test_colour_plan_refuses_main_and_stale_palettes_before_writes(self):
        plan = {'scope': {**CONFIG, 'version':'main'}, 'palette_hash':'a', 'replacements':[], 'counts_before':{}}
        with patch.object(color_tokens, 'snapshot', return_value=(plan, {})), patch.object(trlib, 'call') as call:
            with self.assertRaisesRegex(ValueError, 'dedicated test Version'): color_tokens.apply_plan(plan)
            call.assert_not_called()
        current = {**plan, 'scope':CONFIG, 'palette_hash':'b'}
        with patch.object(color_tokens, 'snapshot', return_value=(current, {})), patch.object(trlib, 'call') as call:
            with self.assertRaisesRegex(ValueError, 'palette changed'): color_tokens.apply_plan({**plan, 'scope':CONFIG})
            call.assert_not_called()

    def test_colour_plan_preserves_unrelated_fields_and_saves_without_publishing(self):
        row = {'target':{'kind':'page','id':'home'},'block_id':'hero','field':'background','before':'#123456','after':'primary'}
        plan = {'scope':CONFIG,'palette_hash':'same','replacements':[row],'counts_before':{'hardcoded_color':1}}
        calls = []
        def call(name, args=None):
            calls.append((name,args))
            if name == 'read_working_copy': return {'working_copy':None}
            if name == 'get_page_blocks': return {'blocks':[{'id':'hero','data':{'background':'#123456','title':'Untouched'}}]}
            if name == 'lint_design_tokens': return {'counts':{'hardcoded_color':0}}
            return {}
        with patch.object(color_tokens, 'snapshot', return_value=(plan, {})), patch.object(trlib, 'call', side_effect=call), patch('builtins.print'):
            color_tokens.apply_plan(plan)
        self.assertEqual([n for n,a in calls], ['read_working_copy','get_page_blocks','update_block','commit_working_copy','lint_design_tokens'])
        self.assertEqual(calls[2][1]['data'], {'background':'primary'})
        with patch.object(color_tokens, 'snapshot', return_value=(plan, {})), patch.object(trlib, 'call', return_value={'working_copy':{'title':'Human draft'}}) as call:
            with self.assertRaisesRegex(ValueError, 'unsaved draft'): color_tokens.apply_plan(plan)
            self.assertEqual(call.call_count,1)

    def client(self):
        client = trlib.Client(CONFIG)
        client.tools = {
            'get_site': {'inputSchema': {'properties': {'site_id': {}}}},
            'update_page': {'inputSchema': {'properties': {'site_id': {}, 'version': {}}}},
            'create_upload_url': {'inputSchema': {'properties': {'site_id': {}}}},
        }
        return client

    def test_binding_before_mutation(self):
        client = self.client()
        calls = []
        def rpc(method, params):
            calls.append(params)
            return {'structuredContent': {'id':'site', 'organization_id':'org'}}
        client.rpc = rpc
        client.call('update_page', {'page_id':'p'})
        self.assertEqual(calls[0]['name'], 'get_site')
        self.assertEqual(calls[1]['arguments']['version'], 'review')
        self.assertEqual(calls[1]['arguments']['site_id'], 'site')
        with self.assertRaises(ValueError): client.call('update_page', {'version':'main'})
        with self.assertRaises(ValueError): client.call('create_upload_url')

    def test_wrong_organization_stops_before_write(self):
        client = self.client()
        with patch.object(client, 'rpc', return_value={'structuredContent':{'id':'site','organization_id':'other'}}) as rpc:
            with self.assertRaises(ValueError): client.call('update_page')
            self.assertEqual(rpc.call_count, 1)

    def test_sse_matches_id_not_last_notification(self):
        raw = 'event: message\ndata: {"id":3,"result":{}}\n\ndata: {"method":"notice"}\n\n'
        self.assertEqual(trlib.decode_rpc(raw, 3)['result'], {})
        with self.assertRaises(ValueError): trlib.decode_rpc(raw, 4)
        self.assertEqual(trlib.decode_rpc('{"id":3,"result":{}}', 3)['result'], {})
        with self.assertRaises(ValueError): trlib.decode_rpc('{"id":4,"result":{}}', 3)

    def test_cursor_pages(self):
        with patch.object(trlib, 'call', side_effect=[{'pages':[{'id':'a'}],'next_cursor':'next'},{'pages':[{'id':'b'}]}]) as call:
            self.assertEqual([x['id'] for x in trlib.all_pages()], ['a','b'])
            self.assertEqual(call.call_args_list[1].args[1]['cursor'], 'next')
        with patch.object(trlib, 'call', return_value={'pages':[], 'next_cursor':'same'}):
            with self.assertRaises(RuntimeError): list(trlib.all_pages())

    def test_offsets(self):
        with patch.object(trlib, 'call', side_effect=[{'urls':[{'path':'/a'}],'total_matching':2},{'urls':[{'path':'/b'}],'total_matching':2}]) as call:
            self.assertEqual(len(list(trlib.all_migration_urls())), 2)
            self.assertEqual(call.call_args_list[1].args[1]['offset'], 1)

    def test_blocks_include_slots(self):
        self.assertEqual([x['id'] for x in trlib.walk([{'id':'a','slots':[[{'id':'b','children':[{'id':'c'}]}]]}])], ['a','b','c'])

    def test_query_and_cross_host_redirects_are_followed_exactly(self):
        with patch.object(parity, 'fetch', side_effect=[(301,'https://media.example.test/new?a=1',b''),(200,None,b'')]) as fetch:
            result = parity.probe('https://old.example.test/old')
            self.assertTrue(result['ok'])
            self.assertEqual(fetch.call_args_list[1].args[0], 'https://media.example.test/new?a=1')

    def test_loops_chains_and_page_redirects(self):
        with patch.object(parity, 'fetch', return_value=(301,'/a',b'')):
            self.assertEqual(parity.probe('https://example.test/a')['error'], 'redirect_loop')
        with patch.object(parity, 'fetch', side_effect=[(301,'/b',b''),(301,'/c',b''),(200,None,b'')]):
            self.assertFalse(parity.probe('https://example.test/a')['ok'])
        with patch.object(parity, 'fetch', side_effect=[(301,'/a/',b''),(200,None,b'')]):
            self.assertTrue(parity.probe('https://example.test/a', True)['ok'])
        with patch.object(parity, 'fetch', side_effect=[(301,'/different/',b''),(200,None,b'')]):
            self.assertFalse(parity.probe('https://example.test/a', True)['ok'])

    def test_assets_relative_query_and_srcset(self):
        parser = Assets('https://example.test/posts/a/')
        parser.feed('<img src="../a.png?v=2" srcset="/b.webp 1x, //media.example.test/c.webp 2x"><a href="/file.pdf?d=1">File</a><img src="data:image/png;base64,AAAA">')
        self.assertEqual(parser.urls, {'https://example.test/posts/a.png?v=2','https://example.test/b.webp','https://media.example.test/c.webp','https://example.test/file.pdf?d=1'})

    def test_preserved_text_excludes_comments_and_scripts(self):
        self.assertEqual(tokens('<h1>A &amp; B</h1><!-- secret --><p>Same <b>copy</b>.</p><script>bad()</script>'), ['A','&','B','Same','copy','.'])

    def test_upload_fails_without_matching_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'image.png'; file.write_bytes(b'synthetic')
            mint = {'upload_url':'https://media.example.test/signed','media_id':'m','cdn_url':'https://media.example.test/m.png'}
            with patch.object(trlib, 'call', side_effect=[mint, {'ok':True,'result':{'sha256':'wrong'}}]), patch.object(trlib.urllib.request, 'build_opener'):
                with self.assertRaisesRegex(ValueError, 'SHA-256'): trlib.upload(file, 'image/png')


if __name__ == '__main__': unittest.main()
