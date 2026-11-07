import { describe, expect, it } from 'vitest';
import {
  buildCoreBlockRegistry, collectBlockAssets, openingHoursField, renderBlocks, siteContext, siteFieldClockHtml, siteFieldValues,
  SITE_FIELD_CLOCK_COMPUTE, SITE_FIELD_CLOCK_SCRIPT, unknownSiteFieldReferences, usesSiteFieldClock,
  type Block, type BlockType, type RenderBlocksOptions, type SiteFieldClockInput, type SiteFieldGroup,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day, index) => (
  index < 5 ? { day, opens: '09:00', closes: '17:00' } : index === 5 ? { day, opens: '10:00', closes: '14:00' } : { day, closed: true }));
const HOURS = { days: WEEK, exceptions: [{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }, { date: '2026-11-11', opens: '12:00', closes: '15:00', note: 'Staff <meeting>' }] };
const GROUPS: SiteFieldGroup[] = [{ id: 'contact', label: 'Contact', fields: [
  { name: 'phone', type: 'text', label: 'Phone' },
  { name: 'intro', type: 'richtext', label: 'Intro' },
  { name: 'delivery_days', type: 'number', label: 'Delivery days' },
  { name: 'season', type: 'select', label: 'Season', options: ['summer', 'winter'], option_labels: ['Summer', 'Winter'] },
  { name: 'reopens', type: 'date', label: 'Reopens' },
  { name: 'show_booking', type: 'boolean', label: 'Show booking' },
  { name: 'secret', type: 'text', label: 'Secret', rendered: false },
  { name: 'address', type: 'object', label: 'Address', fields: [{ name: 'street', type: 'text', label: 'Street' }, { name: 'city', type: 'text', label: 'City' }] },
  { name: 'staff', type: 'array', label: 'Staff', fields: [{ name: 'name', type: 'text', label: 'Name' }, { name: 'role', type: 'text', label: 'Role' }] },
  { name: 'email', type: 'email', label: 'Email' },
  { name: 'website', type: 'url', label: 'Website' },
  openingHoursField(),
] }];
const VALUES = {
  phone: '090-12 34 56 <b>', intro: '<p>Welcome <strong>in</strong></p>', delivery_days: 1234.5, season: 'winter', reopens: '2026-12-28',
  show_booking: true, secret: 'do not show', address: { street: 'Smedjegatan 4', city: 'Umeå' },
  staff: [{ name: 'Ada', role: 'Architect' }, { name: 'Bo', role: 'Builder' }], email: 'hej@example.com', website: 'https://example.com/',
  opening_hours: HOURS, removed_field: 'stale',
};
/** Monday 2026-11-09, 11:30 in Stockholm. */
const MONDAY = new Date('2026-11-09T10:30:00Z');

function render(blocks: Block[], options: Partial<RenderBlocksOptions> & { language?: string; timeZone?: string } = {}): string {
  const { language = 'en', timeZone, ...rest } = options;
  const site = { ...siteContext({ language, ...(timeZone ? { time_zone: timeZone } : {}) }, 2026, { groups: GROUPS, values: VALUES }) };
  return renderBlocks(blocks, { registry, renderVersion: 15, now: MONDAY, siteFieldDefinitions: GROUPS, ...rest, context: { site, ...rest.context } });
}
const field = (data: Record<string, unknown>): Block => ({ id: 'f', type: 'core/site_field', data });
const text = (html: string) => html.replace(/ data-site-field-clock="[^"]*"/g, '').replace(/<[^>]+>/g, '');

describe('site fields in the render context', () => {
  it('holds only the values of defined, public fields', () => {
    const values = siteFieldValues({ groups: GROUPS, values: VALUES });
    expect(values.phone).toBe(VALUES.phone);
    expect(values).not.toHaveProperty('secret');
    expect(values).not.toHaveProperty('removed_field');
    expect(siteContext({ site_name: 'Acme' }, 2026, { groups: GROUPS, values: VALUES }).fields).toEqual(values);
    expect(JSON.stringify(siteContext({}, 2026, { groups: GROUPS, values: VALUES }))).not.toContain('"label"');
    // Without site fields the context is unchanged.
    expect(siteContext({ site_name: 'Acme' }, 2026)).toEqual({ site_name: 'Acme', name: 'Acme', current_year: 2026 });
  });

  it('resolves {{site.fields.*}} in block templates, escaped, and loops over lists', () => {
    const custom: BlockType = {
      id: 'site/contact', name: 'contact', label: 'Contact', category: 'content', container: false, schema: [], origin: 'user', created_at: '1970-01-01T00:00:00Z',
      template: '<p>{{site.fields.phone}}|{{{site.fields.intro}}}|{{site.fields.address.city}}</p><ul>{{#each site.fields.staff}}<li>{{name}}: {{role}}</li>{{/each}}</ul>{{#site.fields.show_booking}}<a>Book</a>{{/site.fields.show_booking}}',
    };
    const html = render([{ id: 'c', type: 'site/contact', data: {} }], { registry: new Map([...registry, [custom.id, custom]]) });
    expect(html).toContain('<p>090-12 34 56 &lt;b&gt;|<p>Welcome <strong>in</strong></p>|Umeå</p>');
    expect(html).toContain('<li>Ada: Architect</li><li>Bo: Builder</li>');
    expect(html).toContain('<a>Book</a>');
  });

  it('binds a whole block field to a site field', () => {
    const html = render([{ id: 't', type: 'core/text', data: { text: '{{site.fields.phone}}' } }]);
    expect(html).toContain('>090-12 34 56 &lt;b&gt;</p>');
    // Inside other text the variable expands from render version 15 (resolveAuthoredVariables), escaped; before, it shows as written.
    expect(render([{ id: 't', type: 'core/text', data: { text: 'Call {{site.fields.phone}}' } }])).toContain('Call 090-12 34 56 &lt;b&gt;<');
    expect(render([{ id: 't', type: 'core/text', data: { text: 'Call {{site.fields.phone}}' } }], { renderVersion: 14 })).toContain('Call {{site.fields.phone}}');
  });
});

describe('core/show_if', () => {
  const child: Block = { id: 'child', type: 'core/prose', data: { html: '<p>Inside</p>' } };
  const showIf = (condition: string) => render([{ id: 's', type: 'core/show_if', data: { condition }, children: [child] }]);

  it('shows its blocks only when the condition holds', () => {
    expect(showIf('site.fields.show_booking')).toContain('Inside');
    expect(showIf('!site.fields.show_booking')).toBe('');
    expect(showIf('site.fields.season === "winter"')).toContain('Inside');
    expect(showIf('site.fields.season === "summer"')).toBe('');
    expect(showIf('site.fields.show_booking && site.fields.season !== "summer"')).toContain('Inside');
  });

  it('fails closed', () => {
    expect(showIf('')).toBe('');
    expect(showIf('site.fields.missing')).toBe('');
    expect(showIf('site.fields.secret')).toBe('');
    expect(showIf('site.fields.season == winter')).toBe('');
  });
});

describe('core/site_field', () => {
  it('shows text escaped with an optional label', () => {
    expect(render([field({ field: 'phone', label: 'Phone <1>' })])).toBe('<p data-block="site_field" data-format="text"><span class="block-site-field-label">Phone &lt;1&gt;</span> <span class="block-site-field-value">090-12 34 56 &lt;b&gt;</span></p>');
    expect(render([field({ field: 'address.city', tag: 'span' })])).toContain('<span data-block="site_field" data-format="text"><span class="block-site-field-value">Umeå</span></span>');
    expect(render([field({ field: 'staff.1.name' })])).toContain('>Bo<');
  });

  it('picks the format by the field', () => {
    expect(render([field({ field: 'intro', tag: 'span' })])).toContain('<div data-block="site_field" data-format="richtext"><div class="block-site-field-value"><p>Welcome <strong>in</strong></p></div></div>');
    expect(render([field({ field: 'delivery_days' })])).toContain('>1,234.5<');
    expect(render([field({ field: 'delivery_days' })], { language: 'sv' })).toMatch(/>1\s234,5</);
    expect(render([field({ field: 'season' })])).toContain('>Winter<');
    expect(render([field({ field: 'reopens' })], { language: 'sv' })).toContain('>28 dec. 2026<');
    expect(render([field({ field: 'staff' })])).toContain('<ul class="block-site-field-value block-site-field-list"><li>Ada – Architect</li><li>Bo – Builder</li></ul>');
    expect(render([field({ field: 'email' })])).toContain('<a href="mailto:hej@example.com">hej@example.com</a>');
    expect(render([field({ field: 'website' })])).toContain('<a href="https://example.com/">https://example.com/</a>');
    expect(render([field({ field: 'opening_hours' })])).toContain('data-format="opening_hours_week"');
  });

  it('follows a chosen format', () => {
    expect(render([field({ field: 'delivery_days', format: 'text' })])).toContain('>1,234.5<');
    expect(render([field({ field: 'phone', format: 'number' })])).toBe('');
    expect(render([field({ field: 'phone', format: 'list' })])).toContain('<li>090-12 34 56 &lt;b&gt;</li>');
  });

  it('renders nothing or the empty text for empty, unknown and private fields', () => {
    expect(render([field({ field: 'missing' })])).toBe('');
    expect(render([field({ field: '' })])).toBe('');
    expect(render([field({ field: 'secret' })])).toBe('');
    expect(render([field({ field: 'show_booking' })])).toBe('');
    expect(render([field({ field: 'missing', label: 'Phone', empty_text: 'Not <yet>' })])).toBe('<p data-block="site_field" data-format="text" data-empty="true"><span class="block-site-field-label">Phone</span> <span class="block-site-field-value">Not &lt;yet&gt;</span></p>');
    expect(render([field({ field: 'phone', format: 'open_now' })])).toBe('');
    // Without site fields at all, as in a site that has none.
    expect(renderBlocks([field({ field: 'phone' })], { registry, renderVersion: 15 })).toBe('');
  });

  it('shows opening hours for a fixed date in the site time zone', () => {
    expect(text(render([field({ field: 'opening_hours', format: 'opening_hours_today' })]))).toBe('09:00–17:00');
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })]))).toBe('Open now, until 17:00');
    expect(text(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: new Date('2026-11-09T17:30:00Z') }))).toBe('Opens tomorrow 09:00');
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })], { now: new Date('2026-11-09T17:30:00Z') }))).toBe('Closed');
    // Saturday evening: Sunday is closed, Monday opens.
    expect(text(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: new Date('2026-11-14T15:00:00Z') }))).toBe('Opens Monday 09:00');
    expect(text(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: new Date('2026-11-09T06:00:00Z'), language: 'sv' }))).toBe('Öppnar i dag 09:00');
    // An exception wins over the weekday; its note shows in bold next to the day, escaped.
    const wednesday = new Date('2026-11-11T09:00:00Z');
    expect(render([field({ field: 'opening_hours', format: 'opening_hours_today' })], { now: wednesday })).toContain('>Today · <strong class="block-site-field-note">Staff &lt;meeting&gt;</strong>: 12:00–15:00</span>');
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })], { now: wednesday }))).toBe('Staff &lt;meeting&gt;: Closed');
    expect(text(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: wednesday }))).toBe('Opens today (Staff &lt;meeting&gt;) 12:00');
    expect(text(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: new Date('2026-11-11T12:00:00Z') }))).toBe('Staff &lt;meeting&gt;: Open now, until 15:00');
    // A day without an exception reads as before.
    expect(render([field({ field: 'opening_hours', format: 'next_opening' })], { now: new Date('2026-11-10T17:30:00Z') })).toContain('>Opens tomorrow (<strong class="block-site-field-note">Staff &lt;meeting&gt;</strong>) 12:00</span>');
    // 16:30 UTC is 17:30 in Stockholm (closed) but 11:30 in New York (open).
    const late = new Date('2026-11-09T16:30:00Z');
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })], { now: late }))).toBe('Closed');
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })], { now: late, timeZone: 'America/New_York' }))).toBe('Open now, until 17:00');
    // An unknown time zone falls back to the zone of the site language.
    expect(text(render([field({ field: 'opening_hours', format: 'open_now' })], { now: late, timeZone: 'Mars/Olympus' }))).toBe('Closed');
    // A Norwegian site without a time zone keeps Oslo time: 23:30 UTC on Sunday is already Monday there.
    const sunday = new Date('2026-11-08T23:30:00Z');
    expect(render([field({ field: 'opening_hours', format: 'open_now' })], { now: sunday, language: 'nb' })).toContain('&quot;z&quot;:&quot;Europe/Oslo&quot;');
    expect(text(render([field({ field: 'opening_hours', format: 'opening_hours_today' })], { now: sunday, language: 'nb' }))).toBe('09:00–17:00');
    expect(text(render([field({ field: 'opening_hours', format: 'opening_hours_today' })], { now: sunday, timeZone: 'Europe/London' }))).toBe('Closed');
  });

  it('shows the week in the page language with today and this week\'s exceptions', () => {
    const html = render([field({ field: 'opening_hours', label: 'Öppettider' })], { language: 'sv', now: new Date('2026-11-11T09:00:00Z') });
    expect(html).toContain('<caption class="block-site-field-label">Öppettider</caption>');
    expect(html).toContain('<tr data-day="monday"><th>Måndag</th><td>09:00–17:00</td></tr>');
    // A day with an exception is marked, with its note in bold under the weekday in the row header.
    expect(html).toContain('<tr data-day="wednesday" data-today="true" aria-current="date" data-exception="true"><th>Onsdag<br><strong class="block-site-field-note">Staff &lt;meeting&gt;</strong></th><td>12:00–15:00</td></tr>');
    expect(html).toContain('<tr data-day="tuesday"><th>Tisdag</th><td>09:00–17:00</td></tr>');
    expect(html).toContain('<tr data-day="sunday"><th>Söndag</th><td>Stängt</td></tr>');
    // Christmas week shows Christmas Eve closed.
    expect(render([field({ field: 'opening_hours' })], { now: new Date('2026-12-21T09:00:00Z') })).toContain('<tr data-day="thursday" data-exception="true"><th>Thursday<br><strong class="block-site-field-note">Christmas Eve</strong></th><td>Closed</td></tr>');
  });

  it('splits a day with a break, shows comments and the comment under the week', () => {
    const lunch = { days: WEEK.map(day => (day.day === 'tuesday' ? { ...day, break_starts: '12:00', break_ends: '13:00', note: 'Lunch closed 12–13' } : day)),
      exceptions: [{ date: '2026-11-12', opens: '10:00', closes: '15:00', note: 'Inventory' }], note: 'Lunch closed 12–13 on Tuesdays' };
    const show = (data: Record<string, unknown>, now: Date, language = 'en') => renderBlocks([field({ field: 'hours', ...data })], {
      registry, renderVersion: 15, now, context: { site: { language, fields: { hours: lunch } } },
    });
    const tuesday = (time: string) => new Date(`2026-11-10T${time}:00Z`);
    const week = show({ format: 'opening_hours_week' }, tuesday('09:00'));
    // A weekday's own comment in normal weight under the weekday; a date exception's in bold.
    expect(week).toContain('<tr data-day="tuesday" data-today="true" aria-current="date"><th>Tuesday<br><span class="block-site-field-note">Lunch closed 12–13</span></th><td>09:00–12:00, 13:00–17:00</td></tr>');
    expect(week).toContain('<tr data-day="thursday" data-exception="true"><th>Thursday<br><strong class="block-site-field-note">Inventory</strong></th><td>10:00–15:00</td></tr>');
    expect(week).toContain('<tr data-day="monday"><th>Monday</th><td>09:00–17:00</td></tr>');
    expect(week).toContain('</tbody></table><p class="block-site-field-hours-note">Lunch closed 12–13 on Tuesdays</p></div>');
    // 11:30, 12:30 and 13:30 in Stockholm.
    expect(text(show({ format: 'open_now' }, tuesday('10:30')))).toBe('Open now, until 12:00');
    expect(text(show({ format: 'open_now' }, tuesday('11:30')))).toBe('Closed, opens again 13:00');
    expect(text(show({ format: 'next_opening' }, tuesday('11:30')))).toBe('Closed, opens again 13:00');
    expect(text(show({ format: 'next_opening' }, tuesday('11:30'), 'sv'))).toBe('Stängt, öppnar igen 13:00');
    expect(text(show({ format: 'open_now' }, tuesday('12:30')))).toBe('Open now, until 17:00');
    expect(text(show({ format: 'opening_hours_today' }, tuesday('09:00')))).toBe('09:00–12:00, 13:00–17:00');
    // A weekday comment stays out of the short formats; a holiday shows there.
    expect(text(show({ format: 'opening_hours_today' }, new Date('2026-11-12T09:00:00Z')))).toBe('Today · Inventory: 10:00–15:00');
  });

  it('has the words for a break in every language', async () => {
    const { UI_LANGUAGES, openingHoursText } = await import('../ui-text.js');
    for (const language of UI_LANGUAGES) expect(openingHoursText(language).reopens, language).toContain('{time}');
  });

  it('embeds the hours, from a week back, for the browser to recompute', () => {
    const html = render([field({ field: 'opening_hours', format: 'open_now' })], { now: new Date('2026-12-01T09:00:00Z') });
    const input = JSON.parse(html.match(/data-site-field-clock="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as SiteFieldClockInput;
    expect(input).toMatchObject({ f: 'open_now', z: 'Europe/Stockholm', t: { closed: 'Closed' } });
    expect(input.x.map(entry => entry.date)).toEqual(['2026-12-24']);
    expect(input.w[0]).toBe('Monday');
  });

  it('reports each date-dependent output for a render cache', () => {
    const outputs: string[] = [];
    render([field({ field: 'opening_hours', format: 'open_now' }), field({ field: 'phone' })], { onClockOutput: (input, html) => outputs.push(`${input.f}:${html}`) });
    expect(outputs).toEqual(['open_now:Open now, until 17:00']);
  });
});

describe('the opening-hours script', () => {
  const compute = new Function(`return ${SITE_FIELD_CLOCK_COMPUTE}`)() as (input: SiteFieldClockInput, now: Date) => string;
  const inputs = (['opening_hours_week', 'opening_hours_today', 'next_opening', 'open_now'] as const).flatMap(f => (['Europe/Stockholm', 'America/New_York', 'Asia/Tokyo'] as const).map(z => ({
    f, z,
    // Lunch breaks (one outside the day, ignored) and weekday comments.
    d: WEEK.map((day, index) => (index === 1 ? { ...day, break_starts: '12:00', break_ends: '13:00', note: 'Lunch closed 12–13' } : index === 3 ? { ...day, break_starts: '18:00', break_ends: '19:00' } : day)),
    x: [...HOURS.exceptions, { date: '2026-03-29', opens: '9:00', closes: '12:00' }, { date: '2026-11-10', closed: true }, { date: '2026-12-23', opens: '10:00', closes: '16:00', break_starts: '12:30', break_ends: '13:00', note: 'Lillejulafton' }],
    w: ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'],
    t: { closed: 'Stängt', open_until: 'Öppet nu, till {time}', opens: 'Öppnar {day} {time}', today: 'i dag', tomorrow: 'i morgon', reopens: 'Stängt, öppnar igen {time}' },
  })));
  // Every half hour across a week with a daylight saving change, Christmas and year end.
  const moments = [Date.parse('2026-03-26T00:00:00Z'), Date.parse('2026-10-22T00:00:00Z'), Date.parse('2026-12-21T00:00:00Z'), Date.parse('2026-12-28T00:00:00Z')]
    .flatMap(start => Array.from({ length: 7 * 48 }, (_, index) => new Date(start + index * 30 * 60_000)));

  // Every input at every moment: thousands of comparisons, slow on a busy CI runner.
  it('computes what the build computes', { timeout: 30_000 }, () => {
    for (const input of inputs) for (const now of moments) expect(compute(input, now), `${input.f} ${input.z} ${now.toISOString()}`).toBe(siteFieldClockHtml(input, now));
  });

  it('moves on with the day without a rebuild', () => {
    const input = inputs.find(entry => entry.f === 'opening_hours_today' && entry.z === 'Europe/Stockholm')!;
    expect(compute(input, MONDAY)).toBe('09:00–17:00');
    expect(compute(input, new Date('2026-11-14T10:00:00Z'))).toBe('10:00–14:00');
    expect(compute(input, new Date('2026-11-15T10:00:00Z'))).toBe('Stängt');
  });

  it('ships only on pages with a date-dependent site field', () => {
    const assets = (blocks: Block[], values?: unknown) => collectBlockAssets(blocks, registry, { renderVersion: 15, siteFieldValues: values }).js;
    expect(assets([field({ field: 'opening_hours', format: 'open_now' })])).toContain(SITE_FIELD_CLOCK_SCRIPT);
    expect(assets([field({ field: 'phone', format: 'text' })])).not.toContain('data-site-field-clock');
    expect(assets([field({ field: 'phone' })], VALUES)).toBe('');
    expect(assets([{ id: 's', type: 'core/show_if', data: {}, children: [field({ field: 'opening_hours' })] }], VALUES)).toContain(SITE_FIELD_CLOCK_SCRIPT);
    // Without the values an automatic format may be opening hours.
    expect(usesSiteFieldClock([field({ field: 'phone' })])).toBe(true);
    expect(assets([field({ field: 'opening_hours', format: 'open_now' })]).length).toBeGreaterThan(0);
    expect(collectBlockAssets([field({ field: 'opening_hours', format: 'open_now' })], registry, { includeScripts: false }).js).toBe('');
  });
});

describe('unknownSiteFieldReferences', () => {
  it('lists site field names that no definition declares', () => {
    const blocks: Block[] = [
      field({ field: 'phone' }), field({ field: 'contact.fax' }), field({ field: 'address.zip' }), field({ field: 'staff.0.name' }),
      { id: 's', type: 'core/show_if', data: { condition: 'site.fields.show_booking && !site.fields.holiday' }, children: [field({ field: '' })] },
    ];
    expect(unknownSiteFieldReferences(blocks, GROUPS).sort()).toEqual(['', 'address.zip', 'contact.fax', 'holiday']);
  });
});
