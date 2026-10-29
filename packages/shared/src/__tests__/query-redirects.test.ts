import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import {
  applyQueryRedirects,
  groupQueryRedirects,
  injectQueryRedirectScript,
  parseQueryRedirectSource,
  queryRedirectMatches,
} from '../query-redirects';
import { matchRedirect, validateRedirectPattern } from '../redirect-patterns';
import { pagesRedirectsFile } from '../pages-redirects';

function runScript(html: string, href: string): string | null {
  const script = /<script data-typeroll-query-redirects="1">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('no script');
  const url = new URL(href);
  let replaced: string | null = null;
  vm.runInNewContext(script, {
    URLSearchParams,
    decodeURI,
    location: { search: url.search, pathname: url.pathname, replace: (to: string) => { replaced = to; } },
  });
  return replaced;
}

describe('query-string redirects', () => {
  it('parses WordPress sources and rejects ambiguous ones', () => {
    expect(parseQueryRedirectSource('/?p=123')).toEqual({ ok: true, source: { path: '/', params: [['p', '123']] } });
    expect(parseQueryRedirectSource('/index.php?page_id=5&lang=de')).toEqual({
      ok: true, source: { path: '/index.php', params: [['page_id', '5'], ['lang', 'de']] },
    });
    for (const bad of ['/?p', '/?p=', '/?p=1&p=2', '/blog/*?p=1', '/:slug?p=1', '/?']) {
      expect(parseQueryRedirectSource(bad).ok).toBe(false);
    }
  });

  it('validates as a fixed redirect and no longer refuses the query', () => {
    expect(validateRedirectPattern('/?p=123', '/umzugstipps/wien/').ok).toBe(true);
    expect(validateRedirectPattern('/?cat=7', 'https://example.com/kategorie/').ok).toBe(true);
    expect(validateRedirectPattern('/?p=123', '/x/:splat').ok).toBe(false);
    expect(validateRedirectPattern('/?p=123#top', '/x/').ok).toBe(false);
  });

  it('matches required parameters exactly and ignores extra ones', () => {
    expect(queryRedirectMatches('/?p=123', '/?p=123')).toBe(true);
    expect(queryRedirectMatches('/?p=123', '/?utm_source=x&p=123')).toBe(true);
    expect(queryRedirectMatches('/?p=123&lang=de', '/?lang=de&p=123')).toBe(true);
    expect(queryRedirectMatches('/?p=123', '/?p=1234')).toBe(false);
    expect(queryRedirectMatches('/?p=123', '/blog/?p=123')).toBe(false);
    expect(queryRedirectMatches('/?p=123', '/')).toBe(false);
    expect(matchRedirect('/?p=123', '/wien/', '/?p=123&utm=1')).toBe('/wien/');
    expect(matchRedirect('/?p=123', '/wien/', '/')).toBeNull();
  });

  it('keeps query rules out of _redirects', () => {
    const file = pagesRedirectsFile([
      { from_path: '/?p=123', to_path: '/wien/', status_code: 301 },
      { from_path: '/alt', to_path: '/neu', status_code: 301 },
    ], { trailing_slash: 'ignore' });
    expect(file).toContain('/alt /neu 301');
    expect(file).not.toContain('?p=');
    expect(pagesRedirectsFile([{ from_path: '/?p=1', to_path: '/x', status_code: 301 }])).toBe('');
  });

  it('publishes a script that redirects only the matching request', () => {
    const rules = groupQueryRedirects([
      { from_path: '/?p=1', to_path: '/one/' },
      { from_path: '/?p=1&lang=de', to_path: '/de/one/' },
      { from_path: '/?cat=7', to_path: 'https://example.com/kategorie/' },
    ]).get('/')!;
    const html = injectQueryRedirectScript('<!doctype html><html><head lang="de"><title>x</title></head><body></body></html>', rules)!;
    expect(html.indexOf('data-typeroll-query-redirects')).toBeLessThan(html.indexOf('<title>'));
    expect(runScript(html, 'https://site.test/?p=1')).toBe('/one/');
    expect(runScript(html, 'https://site.test/?lang=de&p=1')).toBe('/de/one/');
    expect(runScript(html, 'https://site.test/?cat=7&utm_source=x')).toBe('https://example.com/kategorie/');
    expect(runScript(html, 'https://site.test/?p=2')).toBeNull();
    expect(runScript(html, 'https://site.test/')).toBeNull();
    expect(runScript(html, 'https://site.test/other/?p=1')).toBeNull();
  });

  it('cannot break out of the script element', () => {
    const rules = groupQueryRedirects([{ from_path: '/?p=1', to_path: '/</script><script>alert(1)</script>' }]).get('/')!;
    const html = injectQueryRedirectScript('<head></head>', rules)!;
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(runScript(html, 'https://site.test/?p=1')).toBe('/</script><script>alert(1)</script>');
  });

  it('places rules in the document that answers the path, else 404.html', async () => {
    const files = new Map<string, string>([
      ['index.html', '<html><head></head></html>'],
      ['blog/index.html', '<html><head></head></html>'],
      ['404.html', '<html><head></head></html>'],
    ]);
    const report = await applyQueryRedirects([
      { from_path: '/?p=1', to_path: '/one/' },
      { from_path: '/blog/?p=2', to_path: '/two/' },
      { from_path: '/index.php?page_id=3', to_path: '/three/' },
      { from_path: '/plain', to_path: '/ignored/' },
    ], {
      exists: async (relative) => files.has(relative),
      read: async (relative) => files.get(relative)!,
      write: async (relative, text) => { files.set(relative, text); },
    });
    expect(report.unplaced).toEqual([]);
    expect(report.embedded.map(entry => entry.file).sort()).toEqual(['404.html', 'blog/index.html', 'index.html']);
    expect(runScript(files.get('index.html')!, 'https://site.test/?p=1')).toBe('/one/');
    expect(runScript(files.get('blog/index.html')!, 'https://site.test/blog/?p=2')).toBe('/two/');
    expect(runScript(files.get('404.html')!, 'https://site.test/index.php?page_id=3')).toBe('/three/');
    expect(runScript(files.get('404.html')!, 'https://site.test/missing?page_id=3')).toBeNull();
  });
});
