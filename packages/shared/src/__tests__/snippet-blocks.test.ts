// core/snippet: the content as of the publication, the attributes its
// browser script reads, the script itself (choice, cleaning, timers) and the
// live behaviour of core/site_field, whose browser formatter is kept equal
// to the build.
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCoreBlockRegistry, collectBlockAssets, openingHoursField, prepareSiteField, renderBlocks, siteContext, siteFieldClockHtml, siteTimeZone, snippetContentAt, snippetFile,
  snippetReceipt, snippetSourceFrom, unknownSnippetReferences, usesLiveSnippet, SITE_FIELD_CLOCK_COMPUTE, SITE_FIELD_LIVE_COMPUTE, SITE_FIELD_LIVE_SCRIPT,
  SNIPPET_CONTENT_AT_SOURCE, SNIPPET_LIVE_SCRIPT, SNIPPET_SANITIZE_SOURCE,
  type Block, type RenderBlocksOptions, type SiteFieldGroup, type Snippet, type SnippetFile,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const BASE = 'https://media.example.test/media/m1/live';
const lunch: Snippet = {
  id: 'lunch', name: "Today's lunch", kind: 'dated', format: 'html', updated_at: '2026-11-08T08:00:00.000Z', updated_by: 'person:ada',
  entries: [
    { weekday: 'monday', content: '<p>Pea soup</p>' },
    { weekday: 'tuesday', content: '<p>Fish &amp; chips</p>' },
    { date: '2026-11-10', content: '<p>Chef’s special</p>' },
  ],
  fallback: '<p>No lunch today</p>',
};
const notice: Snippet = { id: 'notice', name: 'Notice', kind: 'text', format: 'text', content: 'Closed <today>\nBack tomorrow', updated_at: '2026-11-01T00:00:00.000Z' };
const empty: Snippet = { id: 'empty', name: 'Empty', kind: 'dated', format: 'html', entries: [{ weekday: 'friday', content: '<p>Friday</p>' }], updated_at: '2026-11-01T00:00:00.000Z' };
const files = (zone = 'Europe/Stockholm') => [lunch, notice, empty].map(snippet => snippetFile(snippet, zone));
/** Monday 2026-11-09, 11:30 in Stockholm. */
const MONDAY = new Date('2026-11-09T10:30:00Z');

function render(blocks: Block[], options: Partial<RenderBlocksOptions> & { base?: string | null } = {}): string {
  const { base = BASE, ...rest } = options;
  return renderBlocks(blocks, {
    registry, renderVersion: 15, now: MONDAY, snippetSource: snippetSourceFrom(files()), ...rest,
    context: { site: { language: 'en', ...(base ? { live_base_url: base } : {}) }, ...rest.context },
  });
}
const snippet = (data: Record<string, unknown>): Block => ({ id: 's', type: 'core/snippet', data });

describe('core/snippet', () => {
  it('shows the entry of the build date in the site time zone and names its live file', () => {
    expect(render([snippet({ snippet: 'lunch' })])).toBe('<div data-block="snippet" data-snippet="lunch" data-format="html" data-snippet-src="https://media.example.test/media/m1/live/lunch.json" data-updated="2026-11-08T08:00:00.000Z" data-snippet-date="2026-11-09"><p>Pea soup</p></div>');
    // A date wins over its weekday; a day without an entry shows the fallback.
    expect(render([snippet({ snippet: 'lunch' })], { now: new Date('2026-11-10T10:00:00Z') })).toContain('data-snippet-date="2026-11-10"><p>Chef’s special</p>');
    expect(render([snippet({ snippet: 'lunch' })], { now: new Date('2026-11-11T10:00:00Z') })).toContain('><p>No lunch today</p>');
    // 23:30 UTC on Sunday is Monday in Oslo, the zone of a Norwegian site without a time zone.
    const sunday = new Date('2026-11-08T23:30:00Z');
    const oslo = snippetSourceFrom([snippetFile(lunch, siteTimeZone({ language: 'nb' }))]);
    expect(siteTimeZone({ language: 'nb' })).toBe('Europe/Oslo');
    expect(render([snippet({ snippet: 'lunch' })], { now: sunday, snippetSource: oslo })).toContain('data-snippet-date="2026-11-09"><p>Pea soup</p>');
    expect(render([snippet({ snippet: 'lunch' })], { now: sunday, snippetSource: snippetSourceFrom([snippetFile(lunch, 'Europe/London')]) })).toContain('data-snippet-date="2026-11-08"><p>No lunch today</p>');
  });

  it('escapes text, keeps HTML for the page sanitizer and follows the chosen element', () => {
    expect(render([snippet({ snippet: 'notice', tag: 'p' })])).toBe('<p data-block="snippet" data-snippet="notice" data-format="text" data-snippet-src="https://media.example.test/media/m1/live/notice.json" data-updated="2026-11-01T00:00:00.000Z">Closed &lt;today&gt;\nBack tomorrow</p>');
    expect(render([snippet({ snippet: 'lunch', tag: 'aside' })])).toMatch(/^<aside data-block="snippet"[^>]*><p>Pea soup<\/p><\/aside>$/);
    expect(render([snippet({ snippet: 'lunch', tag: 'script' })])).toMatch(/^<div /);
  });

  it('shows the empty text, or keeps a hidden place the browser can fill', () => {
    expect(render([snippet({ snippet: 'empty' })])).toBe('<div data-block="snippet" data-snippet="empty" data-format="html" data-snippet-src="https://media.example.test/media/m1/live/empty.json" data-updated="2026-11-01T00:00:00.000Z" data-snippet-date="2026-11-09" data-empty="true" hidden></div>');
    expect(render([snippet({ snippet: 'empty', empty_text: 'Nothing <today>' })])).toContain('data-empty="true" data-empty-text="Nothing &lt;today&gt;">Nothing &lt;today&gt;</div>');
    // A snippet the site does not have keeps a place too, while it is live.
    expect(render([snippet({ snippet: 'missing' })])).toBe('<div data-block="snippet" data-snippet="missing" data-snippet-src="https://media.example.test/media/m1/live/missing.json" data-empty="true" hidden></div>');
    expect(render([snippet({ snippet: 'missing' })], { base: null })).toBe('');
    expect(render([snippet({ snippet: 'missing', empty_text: 'Soon' })], { base: null })).toBe('<div data-block="snippet" data-snippet="missing" data-empty="true">Soon</div>');
    expect(render([snippet({ snippet: '' })])).toBe('');
    expect(render([snippet({ snippet: '../x' })])).toBe('');
  });

  it('names no live file without a live base URL or when the block is not live', () => {
    for (const html of [render([snippet({ snippet: 'lunch' })], { base: null }), render([snippet({ snippet: 'lunch', live: false })]),
      render([snippet({ snippet: 'lunch' })], { base: 'http://insecure.example.test/live' })]) {
      expect(html).toContain('<p>Pea soup</p>');
      expect(html).not.toContain('data-snippet-src');
    }
  });

  it('ships its script only for a live snippet on a site with live files', () => {
    const js = (blocks: Block[], liveBaseUrl?: string) => collectBlockAssets(blocks, registry, { renderVersion: 15, liveBaseUrl }).js;
    expect(js([snippet({ snippet: 'lunch' })], BASE)).toContain(SNIPPET_LIVE_SCRIPT);
    expect(js([{ id: 'c', type: 'core/container', data: {}, children: [snippet({ snippet: 'lunch' })] }], BASE)).toContain(SNIPPET_LIVE_SCRIPT);
    expect(js([snippet({ snippet: 'lunch' })])).toBe('');
    expect(js([snippet({ snippet: 'lunch', live: false })], BASE)).toBe('');
    expect(usesLiveSnippet([snippet({ snippet: '' })])).toBe(false);
  });

  it('lists blocks that name an unknown snippet', () => {
    expect(unknownSnippetReferences([snippet({ snippet: 'lunch' }), snippet({ snippet: 'gone' }), snippet({})], new Set(['lunch']))).toEqual(['gone', '']);
  });

  it('gives a render cache what the output depends on', () => {
    const file = files()[0]!;
    expect(snippetReceipt(file, MONDAY)).toEqual({ kind: 'dated', format: 'html', content: '<p>Pea soup</p>', updated_at: lunch.updated_at, date: '2026-11-09' });
    expect(snippetReceipt(null, MONDAY)).toBeNull();
    expect(JSON.stringify(file)).not.toContain('person:ada');
  });
});

describe('the snippet sanitizer', () => {
  let open: Window | null = null;
  afterEach(async () => { await open?.happyDOM.close(); open = null; });
  const sanitizer = () => {
    open = new Window();
    return new Function('DOMParser', `return (${SNIPPET_SANITIZE_SOURCE})`)(open.DOMParser) as (html: string) => string;
  };

  it('keeps the rich text tags and attributes', () => {
    const clean = sanitizer();
    const html = '<h2>Menu</h2><p>Soup <strong>and</strong> <em>bread</em>, <b>b</b> <i>i</i> <u>u</u> <s>s</s> <small>small</small> <mark>mark</mark><br><span>x</span></p>'
      + '<ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Q</blockquote><h6>six</h6>'
      + '<p><a href="https://example.com/a" title="T" rel="nofollow" target="_blank">ext</a> <a href="/menu/">rel</a> <a href="mailto:a@example.com">m</a> <a href="tel:+4690">t</a> <a href="#top">top</a></p>'
      + '<img src="https://example.com/i.jpg" alt="Soup" width="300" height="200">';
    expect(clean(html)).toBe('<h2>Menu</h2><p>Soup <strong>and</strong> <em>bread</em>, <b>b</b> <i>i</i> <u>u</u> <s>s</s> <small>small</small> <mark>mark</mark><br><span>x</span></p>'
      + '<ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Q</blockquote><h6>six</h6>'
      + '<p><a href="https://example.com/a" title="T" rel="nofollow noopener" target="_blank">ext</a> <a href="/menu/">rel</a> <a href="mailto:a@example.com">m</a> <a href="tel:+4690">t</a> <a href="#top">top</a></p>'
      + '<img src="https://example.com/i.jpg" alt="Soup" width="300" height="200">');
  });

  it('drops scripts, handlers, styles, dangerous URLs and foreign content', () => {
    const clean = sanitizer();
    expect(clean('<p>Hi<script>alert(1)</script></p>')).toBe('<p>Hi</p>');
    expect(clean('<img src=x onerror="alert(1)"><img src="javascript:alert(1)" alt="a">')).toBe('<img src="x">');
    expect(clean('<p onclick="x()" style="color:red" class="c" id="i">Text</p>')).toBe('<p>Text</p>');
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', '//evil.example/x', 'https://a b']) {
      expect(clean(`<a href="${href}">x</a>`), href).toBe('<a>x</a>');
    }
    expect(clean('<img src="data:image/png;base64,AAAA" alt="d">')).toBe('');
    expect(clean('<a href="mailto:a@b.c"><img src="mailto:a@b.c"></a>')).toBe('<a href="mailto:a@b.c"></a>');
    expect(clean('<svg><a href="javascript:x"><text>t</text></a></svg><p>after</p>')).toBe('<p>after</p>');
    expect(clean('<math><mi>x</mi></math><p>after</p>')).toBe('<p>after</p>');
    expect(clean('<p>a</p><svg><script>x()</script></svg>')).toBe('<p>a</p>');
    expect(clean('<iframe src="https://evil.example"></iframe><style>p{}</style><template><p>t</p></template><form><input></form><p>ok</p>')).toBe('<p>ok</p>');
    // Other elements are unwrapped, their text kept and escaped.
    expect(clean('<div><table><tr><td>cell &lt;b&gt;</td></tr></table></div><font color="red">f</font>')).toBe('cell &lt;b&gt;f');
    expect(clean('<a href="/x" target="top">x</a><img src="/a.jpg" width="100%">')).toBe('<a href="/x">x</a><img src="/a.jpg">');
    // Nested mutation tricks stay inert.
    expect(clean('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>')).not.toMatch(/onerror|<img/);
    expect(clean('<p><!-- <img src=x onerror=alert(1)> --></p>')).toBe('<p></p>');
  });
});

describe('the snippet browser script', () => {
  let open: Window | null = null;
  afterEach(async () => { await open?.happyDOM.close(); open = null; });

  async function page(html: string, file: unknown, now: Date) {
    open = new Window({ url: 'https://site.example.test/' });
    const window = open;
    window.document.body.innerHTML = html;
    const requests: string[] = [];
    const timers: Array<{ ms: number; run: () => void }> = [];
    const fetch = async (url: string, init: { credentials?: string }) => {
      requests.push(`${url} ${init?.credentials}`);
      return file === 404 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => structuredClone(file) };
    };
    const RealDate = Date;
    let current = now.getTime();
    class FixedDate extends RealDate {
      constructor(...args: unknown[]) { if (args.length) super(...(args as [string])); else super(current); }
      static now() { return current; }
    }
    const run = new Function('document', 'fetch', 'setTimeout', 'DOMParser', 'Date', SNIPPET_LIVE_SCRIPT);
    run(window.document, fetch, (fn: () => void, ms: number) => { timers.push({ ms, run: fn }); return timers.length; }, window.DOMParser, FixedDate);
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    await settle();
    return { window, requests, timers, settle, at: (date: Date) => { current = date.getTime(); } };
  }
  const built = (at: Date) => render([snippet({ snippet: 'lunch' })], { now: at });

  it('keeps current published content and fetches the file once without credentials', async () => {
    const { window, requests } = await page(built(MONDAY) + built(MONDAY), snippetFile(lunch, 'Europe/Stockholm'), MONDAY);
    expect(requests).toEqual([`${BASE}/lunch.json omit`]);
    expect(window.document.querySelector('[data-snippet]')!.innerHTML).toBe('<p>Pea soup</p>');
  });

  it('shows a newer version, cleaned, and the next day at midnight', async () => {
    const newer = { ...snippetFile(lunch, 'Europe/Stockholm'), updated_at: '2026-11-09T09:00:00.000Z',
      entries: [{ weekday: 'monday', content: '<p onclick="x()">Lentil soup<script>x()</script></p>' }, { weekday: 'tuesday', content: '<p>Fish</p>' }] };
    const { window, timers, settle, at } = await page(built(MONDAY), newer, MONDAY);
    const node = window.document.querySelector('[data-snippet]')!;
    expect(node.innerHTML).toBe('<p>Lentil soup</p>');
    expect(node.getAttribute('data-updated')).toBe('2026-11-09T09:00:00.000Z');
    // 11:30 in Stockholm: midnight is 12.5 hours away, with a few seconds' margin.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe((12.5 * 3600 + 5) * 1000);
    at(new Date('2026-11-10T00:00:05Z'));
    timers[0]!.run();
    await settle();
    expect(node.innerHTML).toBe('<p>Fish</p>');
    expect(node.getAttribute('data-snippet-date')).toBe('2026-11-10');
  });

  it('sets text as text, fills an empty place and hides it again', async () => {
    const text = { ...snippetFile(notice, 'Europe/Stockholm'), content: '<b>Open</b> again', updated_at: '2' };
    const first = await page(render([snippet({ snippet: 'notice' })]), text, MONDAY);
    expect(first.window.document.querySelector('[data-snippet]')!.textContent).toBe('<b>Open</b> again');
    await open!.happyDOM.close();
    const filled = { ...snippetFile(empty, 'Europe/Stockholm'), updated_at: '2', entries: [{ weekday: 'monday', content: '<p>Monday</p>' }] };
    const second = await page(render([snippet({ snippet: 'empty' })]), filled, MONDAY);
    const node = second.window.document.querySelector('[data-snippet]') as unknown as { hidden: boolean; innerHTML: string; hasAttribute(name: string): boolean };
    expect(node.hidden).toBe(false);
    expect(node.innerHTML).toBe('<p>Monday</p>');
    expect(node.hasAttribute('data-empty')).toBe(false);
  });

  it('keeps the published content on a failed request or an unexpected file', async () => {
    for (const file of [404, { id: 'other', kind: 'html', format: 'html', content: '<p>x</p>', updated_at: '9' }, { id: 'lunch', kind: 'dated', format: 'html', entries: 'no', updated_at: '9' }, { id: 'lunch', kind: 'html', format: 'svg', content: 'x', updated_at: '9' }, null]) {
      const { window } = await page(built(MONDAY), file, MONDAY);
      expect(window.document.querySelector('[data-snippet]')!.innerHTML).toBe('<p>Pea soup</p>');
      await open!.happyDOM.close();
      open = null;
    }
  });

  it('chooses content like the build at every hour of two weeks', () => {
    const browser = new Function(`return (${SNIPPET_CONTENT_AT_SOURCE})`)() as (file: SnippetFile, at: Date) => string;
    for (const zone of ['Europe/Stockholm', 'America/New_York', 'Pacific/Kiritimati']) {
      const file = snippetFile(lunch, zone);
      for (let hour = 0; hour < 24 * 14; hour++) {
        const at = new Date(Date.UTC(2026, 10, 2, hour));
        expect(browser(file, at)).toBe(snippetContentAt(file, at));
      }
    }
  });
});

describe('live site fields', () => {
  const GROUPS: SiteFieldGroup[] = [{ id: 'live', label: 'Live', fields: [
    { name: 'delivery_days', type: 'number', label: 'Delivery days', live: true },
    { name: 'notice', type: 'text', label: 'Notice', live: true },
    { name: 'season', type: 'select', label: 'Season', options: ['summer', 'winter'], option_labels: ['Summer', 'Winter'], live: true },
    { name: 'reopens', type: 'date', label: 'Reopens', live: true },
    { name: 'website', type: 'url', label: 'Website', live: true },
    { name: 'email', type: 'email', label: 'Email', live: true },
    { name: 'photo', type: 'image', label: 'Photo', live: true },
    { name: 'intro', type: 'richtext', label: 'Intro', live: true },
    { name: 'contact', type: 'object', label: 'Contact', live: true, fields: [{ name: 'phone', type: 'text', label: 'Phone' }] },
    { ...openingHoursField(), live: true },
    { name: 'phone', type: 'text', label: 'Phone' },
  ] }];
  const VALUES = { delivery_days: 3, notice: 'Closed <today>', season: 'winter', reopens: '2026-12-28', website: 'https://example.com/', email: 'a@example.com',
    photo: '/media/p.jpg', intro: '<p>Hi</p>', contact: { phone: '090-1' }, phone: '1',
    opening_hours: { days: [{ day: 'monday', opens: '09:00', closes: '17:00', break_starts: '12:00', break_ends: '13:00' }], exceptions: [{ date: '2026-11-10', closed: true, note: 'Staff day' }], note: 'Lunch 12–13' } };
  const field = (data: Record<string, unknown>): Block => ({ id: 'f', type: 'core/site_field', data });
  const show = (data: Record<string, unknown>, options: { base?: string | null; values?: Record<string, unknown>; language?: string; now?: Date } = {}) => renderBlocks([field(data)], {
    registry, renderVersion: 15, now: options.now ?? MONDAY, siteFieldDefinitions: GROUPS,
    context: { site: { ...siteContext({ language: options.language ?? 'en', date_format: 'long' }, 2026, { groups: GROUPS, values: options.values ?? VALUES }), ...(options.base !== null ? { live_base_url: options.base ?? BASE } : {}) } },
  });
  const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const spec = (html: string) => JSON.parse(unescape(html.match(/data-site-field-live="([^"]*)"/)![1]!));
  const clock = new Function(`return ${SITE_FIELD_CLOCK_COMPUTE}`)();
  const live = new Function(`return ${SITE_FIELD_LIVE_COMPUTE}`)() as (s: unknown, value: unknown, now: Date, clock: unknown) => { h: string; e: boolean } | null;

  it('names the live fields file only for live fields on a site with live files', () => {
    expect(show({ field: 'notice', label: 'Note' })).toMatch(/^<p data-block="site_field" data-format="text" data-site-field="notice" data-site-field-src="https:\/\/media\.example\.test\/media\/m1\/live\/_fields\.json" data-site-field-live="[^"]+"><span class="block-site-field-label">Note<\/span> <span class="block-site-field-value">Closed &lt;today&gt;<\/span><\/p>$/);
    expect(show({ field: 'contact.phone' })).toContain('data-site-field="contact.phone"');
    // Not live: a field without the flag, no live base URL, rich text and lists.
    expect(show({ field: 'phone' })).toBe('<p data-block="site_field" data-format="text"><span class="block-site-field-value">1</span></p>');
    expect(show({ field: 'notice' }, { base: null })).not.toContain('data-site-field-src');
    expect(show({ field: 'intro' })).not.toContain('data-site-field-src');
    expect(show({ field: 'notice', format: 'list' })).not.toContain('data-site-field-src');
  });

  it('keeps a hidden place for an empty live field', () => {
    expect(show({ field: 'notice' }, { values: { ...VALUES, notice: '' } })).toMatch(/^<p data-block="site_field" data-format="text" data-empty="true" data-site-field="notice"[^>]* hidden><\/p>$/);
    expect(show({ field: 'notice' }, { values: { ...VALUES, notice: '' }, base: null })).toBe('');
  });

  it('formats a newer value exactly as the build does', () => {
    const cases: Array<[Record<string, unknown>, unknown[]]> = [
      [{ field: 'notice', label: 'Note <1>', empty_text: 'None' }, ['Hello <b>', '  padded  ', '', null, 42.5, true, false]],
      [{ field: 'delivery_days', label: 'Days' }, [3, 1234.5, '7', 'x', '', null]],
      [{ field: 'delivery_days', format: 'text' }, [1234.5, 'a']],
      [{ field: 'season' }, ['winter', 'summer', 'autumn']],
      [{ field: 'reopens' }, ['2026-12-28', '2026-12-28T10:00:00Z', 'soon', '']],
      [{ field: 'website' }, ['https://example.com/', 'javascript:alert(1)', '/local/', 'ftp://x']],
      [{ field: 'email' }, ['a@example.com', 'not an email']],
      [{ field: 'photo' }, ['/media/x.jpg', 'javascript:x']],
      [{ field: 'contact.phone', tag: 'span' }, ['090-2', '']],
      [{ field: 'opening_hours', label: 'Hours' }, [VALUES.opening_hours, { days: [] }, null, { days: [{ day: 'monday', closed: true, note: 'Renovation' }] }]],
      [{ field: 'opening_hours', format: 'open_now', empty_text: 'Ask us' }, [VALUES.opening_hours, null]],
      [{ field: 'opening_hours', format: 'next_opening' }, [VALUES.opening_hours]],
      [{ field: 'opening_hours', format: 'opening_hours_today' }, [VALUES.opening_hours]],
    ];
    for (const language of ['en', 'sv', 'de']) for (const [data, values] of cases) {
      const specification = spec(show(data, { language }));
      for (const value of values) for (const now of [MONDAY, new Date('2026-11-09T11:30:00Z'), new Date('2026-11-10T08:00:00Z')]) {
        const name = String(data.field).split('.');
        const source = name.length === 2 ? { ...VALUES, [name[0]!]: { phone: value } } : { ...VALUES, [name[0]!]: value };
        const expected = prepareSiteField(data, { values: siteContext({}, 2026, { groups: GROUPS, values: source }).fields, definitions: GROUPS, language, dateFormat: 'long', timeZone: siteTimeZone({ language }), now, liveBaseUrl: BASE });
        expect(live(specification, name.length === 2 ? value : source[name[0]! as keyof typeof source], now, clock), `${language} ${JSON.stringify(data)} ${JSON.stringify(value)} ${now.toISOString()}`)
          .toEqual({ h: expected.html, e: expected.empty });
      }
    }
    // A value it cannot show keeps the published one.
    expect(live(spec(show({ field: 'notice' })), { label: 'x' }, MONDAY, clock)).toBeNull();
    expect(live(spec(show({ field: 'notice' })), ['a'], MONDAY, clock)).toBeNull();
  });

  it('recomputes opening hours from the new value with the week\'s break and comment', () => {
    const html = show({ field: 'opening_hours', label: 'Hours' });
    expect(html).toContain('<td>09:00–12:00, 13:00–17:00</td>');
    expect(html).toContain('<p class="block-site-field-hours-note">Lunch 12–13</p>');
    const result = live(spec(html), { days: [{ day: 'monday', opens: '10:00', closes: '14:00' }] }, MONDAY, clock)!;
    expect(result.h).toContain('<tr data-day="monday" data-today="true" aria-current="date"><th>Monday</th><td>10:00–14:00</td></tr>');
    expect(result.h).not.toContain('hours-note');
    expect(siteFieldClockHtml(JSON.parse(unescape(result.h.match(/data-site-field-clock="([^"]*)"/)![1]!)), MONDAY)).toContain('10:00–14:00');
  });

  it('ships its script only with a live field and a live base URL', () => {
    const js = (blocks: Block[], liveBaseUrl?: string) => collectBlockAssets(blocks, registry, { renderVersion: 15, liveBaseUrl, siteFieldDefinitions: GROUPS, siteFieldValues: VALUES }).js;
    expect(js([field({ field: 'notice' })], BASE)).toContain(SITE_FIELD_LIVE_SCRIPT);
    expect(js([field({ field: 'notice' })])).toBe('');
    expect(js([field({ field: 'phone' })], BASE)).toBe('');
    expect(js([field({ field: 'intro', format: 'richtext' })], BASE)).toBe('');
  });

  describe('the browser script', () => {
    let open: Window | null = null;
    afterEach(async () => { await open?.happyDOM.close(); open = null; });
    async function page(html: string, file: unknown) {
      open = new Window({ url: 'https://site.example.test/' });
      open.document.body.innerHTML = html;
      const requests: string[] = [];
      const fetch = async (url: string) => { requests.push(url); return { ok: true, json: async () => structuredClone(file) }; };
      new Function('document', 'fetch', SITE_FIELD_LIVE_SCRIPT)(open.document, fetch);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { document: open.document, requests };
    }

    it('fetches the file once and shows the new values', async () => {
      const html = show({ field: 'notice', label: 'Note' }) + show({ field: 'delivery_days' }) + show({ field: 'season' }, { values: { ...VALUES, season: '' } });
      const { document, requests } = await page(html, { values: { notice: 'Open <again>', delivery_days: 5, season: 'summer' }, time_zone: 'Europe/Stockholm', updated_at: 'x' });
      expect(requests).toEqual([`${BASE}/_fields.json`]);
      const nodes = document.querySelectorAll('[data-site-field-src]') as unknown as Array<{ innerHTML: string; hidden: boolean }>;
      expect(nodes[0]!.innerHTML).toBe('<span class="block-site-field-label">Note</span> <span class="block-site-field-value">Open &lt;again&gt;</span>');
      expect(nodes[1]!.innerHTML).toBe('<span class="block-site-field-value">5</span>');
      expect(nodes[2]!.innerHTML).toBe('<span class="block-site-field-value">Summer</span>');
      expect(nodes[2]!.hidden).toBe(false);
    });

    it('hides a field emptied since, and keeps one the file does not have', async () => {
      const html = show({ field: 'notice' }) + show({ field: 'delivery_days' });
      const { document } = await page(html, { values: { notice: null } });
      const nodes = document.querySelectorAll('[data-site-field-src]') as unknown as Array<{ innerHTML: string; hidden: boolean }>;
      expect(nodes[0]!.hidden).toBe(true);
      expect(nodes[1]!.innerHTML).toBe('<span class="block-site-field-value">3</span>');
    });
  });
});
