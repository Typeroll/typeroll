// Server render of the snippet pages and the live flag on site fields. The
// editing operations are covered in snippet-model.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { openingHoursField, type SiteFields, type Snippet } from '@typeroll/shared';
import SnippetEditor, { savedMessage } from '../../components/SnippetEditor';
import SnippetList, { liveNotice } from '../../components/SnippetList';
import SiteFieldsEditor, { GroupDefinition, type DefinitionContext } from '../../components/SiteFieldsEditor';

const lunch: Snippet = {
  id: 'lunch', name: 'Lunch', kind: 'dated', format: 'html',
  entries: [{ weekday: 'monday', content: '<p>Meatballs</p>' }, { date: '2026-11-10', content: '<p>Closed for training</p>' }],
  fallback: '<p>No lunch today</p>', updated_at: '2026-11-07T10:00:00.000Z', updated_by: 'anna@example.com',
};
const now = new Date('2026-11-09T08:00:00Z'); // Monday

const editor = (snippet: Snippet, canEdit = true, extra: Record<string, unknown> = {}) =>
  renderToString(createElement(SnippetEditor, { siteId: 'site', snippetId: snippet.id, canEdit, initial: snippet, now, timeZone: 'Europe/Stockholm', ...extra }));

describe('SnippetEditor', () => {
  it('gives a dated snippet a week of rows, its dates and the fallback', () => {
    const html = editor(lunch);
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) expect(html).toContain(`aria-label="${day}"`);
    expect(html).toContain('Copy Monday to Tuesday–Friday');
    expect(html).toContain('Clear the week');
    expect(html).toContain('Specific dates');
    expect(html).toContain('value="2026-11-10"');
    expect(html).toContain('When there is nothing for the day');
    expect(html).toContain('Save snippet');
  });

  it('previews the next seven days, today first', () => {
    const html = editor(lunch);
    expect(html).toContain('Show this week');
    expect(html).toMatch(/Today, <!-- -->Mon 9 Nov/);
    expect(html).toContain('Meatballs');
    expect(html).toMatch(/Tomorrow, <!-- -->Tue 10 Nov/);
    expect(html).toContain('Closed for training');
    expect(html).toContain('No lunch today');
  });

  it('says which time zone the days follow and links to the setting', () => {
    const html = editor(lunch, true, { timeZone: 'Europe/Oslo' });
    expect(html).toContain('Days follow <!-- -->Europe/Oslo<!-- --> (the site&#x27;s time zone).');
    expect(html).toContain('href="/app/sites/site/settings?section=seo">Change it in Settings, next to Language.</a>');
    expect(html).toContain('in <!-- -->Europe/Oslo');
  });

  it('edits a text snippet in one text area and shows how to use it', () => {
    const html = editor({ id: 'notice', name: 'Notice', kind: 'text', format: 'text', content: 'Closed on Monday' });
    expect(html).toMatch(/<textarea[^>]*aria-label="Content"[^>]*>Closed on Monday<\/textarea>/);
    expect(html).not.toContain('Show this week');
    expect(html).toContain('How to show it');
    expect(html).toContain('aria-label="Copy the id notice"');
    expect(html).toContain('<strong>Snippet</strong> block');
  });

  it('uses the rich text editor for a rich text snippet', () => {
    expect(editor({ id: 'news', name: 'News', kind: 'html', format: 'html', content: '<p>Hi</p>' })).toContain('role="toolbar"');
  });

  it('is read-only without write access', () => {
    const html = editor(lunch, false);
    expect(html).not.toContain('Save snippet');
    expect(html).not.toContain('Delete this snippet');
    expect(html).toContain('Changing it needs write access');
    expect(html).toContain('Meatballs');
  });

  it('keeps its stylesheet as raw text so hydration matches', () => {
    expect(editor(lunch)).toMatch(/<style>[^<]*input:not\(\[type="checkbox"\]/);
  });

  it('says a saved snippet is live within a minute, or why not', () => {
    expect(savedMessage({ published: true })).toEqual({ kind: 'live', message: 'Saved. Live on the site within a minute.' });
    expect(savedMessage({ published: false, reason: 'The site has no media bucket yet' }).message)
      .toBe('Saved. The site has no media bucket yet. The site shows the change at the next publication.');
  });
});

describe('SnippetList', () => {
  const list = (snippets: Snippet[], live = { supported: true }, canEdit = true) =>
    renderToString(createElement(SnippetList, { siteId: 'site', canEdit, initial: { snippets, live } }));

  it('lists snippets with their kind, who updated them and whether they are live', () => {
    const html = list([lunch, { id: 'notice', name: 'Notice', kind: 'text', content: '' }]);
    expect(html).toContain('href="/app/sites/site/snippets/lunch"');
    expect(html).toContain('By day/date');
    expect(html).toContain('by anna@example.com');
    expect(html).toContain('Live');
    expect(html).toContain('New snippet');
  });

  it('explains snippets with the lunch example when there are none', () => {
    const html = list([]);
    expect(html).toContain('No snippets yet');
    expect(html).toContain('today&#x27;s lunch');
    for (const kind of ['Text', 'Rich text', 'By day/date']) expect(html).toContain(`<strong>${kind}</strong>`);
  });

  it('says when live updating is not supported, with the reason', () => {
    const html = list([lunch], { supported: false, reason: 'The site publishes to GitHub Pages' } as never);
    expect(html).toContain('The site publishes to GitHub Pages.');
    expect(html).toContain('At the next publication');
    expect(liveNotice({ supported: true })).toBeNull();
  });

  it('offers no create form without write access', () => {
    expect(list([], undefined, false)).not.toContain('New snippet</button>');
  });
});

describe('live site fields', () => {
  const fields: SiteFields = {
    updated_at: '2026-11-07T10:00:00.000Z',
    groups: [{ id: 'shop', label: 'Shop', access: 'editor', fields: [
      { name: 'delivery', type: 'text', label: 'Delivery time', live: true } as never,
      { name: 'phone', type: 'text', label: 'Phone' },
      openingHoursField(),
    ] }],
    values: {},
  };

  it('marks live fields in the values view', () => {
    const html = renderToString(createElement(SiteFieldsEditor, { siteId: 'site', permission: 'write', initial: fields, timeZone: 'Europe/Helsinki' }));
    expect(html.match(/class="sf-live"/g)).toHaveLength(1);
    expect(html).toContain('Days follow <!-- -->Europe/Helsinki<!-- --> (the site&#x27;s time zone).');
  });

  it('offers a break and a comment per weekday and a comment under the hours', () => {
    const withBreak: SiteFields = { ...fields, values: { opening_hours: { note: 'Ring the bell', days: [
      { day: 'monday', closed: false, opens: '09:00', closes: '17:00', break_starts: '08:00', break_ends: '13:00', note: 'Lunch closed 12–13' },
    ], exceptions: [] } } };
    const html = renderToString(createElement(SiteFieldsEditor, { siteId: 'site', permission: 'write', initial: withBreak, timeZone: 'Europe/Stockholm' }));
    expect(html).toMatch(/aria-label="Monday break from" value="08:00"/);
    expect(html).toContain('aria-label="Add break on Tuesday"');
    expect(html).toMatch(/aria-label="Comment for Monday" value="Lunch closed 12–13"/);
    expect(html).toContain('Monday<!-- -->: <!-- -->The break must lie inside the opening hours (09:00–17:00)');
    expect(html).toMatch(/Comment under the hours<\/label><textarea[^>]*>Ring the bell<\/textarea>/);
  });

  it('dims past dates with deviating hours, sorts them and flags a date used twice', () => {
    const withDates: SiteFields = { ...fields, values: { opening_hours: { days: [], exceptions: [
      { date: '2026-12-24', closed: true, note: 'Christmas Eve' }, { date: '2026-11-01', closed: true }, { date: '2026-12-24', closed: false, opens: '10:00', closes: '14:00' },
    ] } } };
    const html = renderToString(createElement(SiteFieldsEditor, { siteId: 'site', permission: 'write', initial: withDates, timeZone: 'Europe/Stockholm', now: new Date('2026-11-07T12:00:00Z') }));
    expect(html.indexOf('value="2026-11-01"')).toBeLessThan(html.indexOf('value="2026-12-24"'));
    expect(html).toMatch(/<li class="is-past">/);
    expect(html).toContain('Remove past dates (<!-- -->1<!-- -->)');
    expect(html.match(/Two exceptions on 2026-12-24: keep one/g)).toHaveLength(2);
    expect(html).toContain('Thursday 24 December');
    expect(html).toContain('placeholder="Christmas Eve"');
  });

  it('offers the live checkbox on top-level fields when defining them', () => {
    const ctx: DefinitionContext = {
      domId: 'd', groups: fields.groups, groupIndex: 0, savedNames: new Set(), savedGroupIds: new Set(['shop']), values: {},
      errors: { general: [], byKey: new Map() }, open: new Set(['0:0', '0:1']), setOpen: () => {}, pendingFocus: { current: null }, onChange: () => {},
    };
    const html = renderToString(createElement(GroupDefinition, { ...ctx, onRemove: () => {}, onMove: () => {} }));
    expect(html.match(/Live \(updates without publishing\)/g)).toHaveLength(2);
    expect(html).toMatch(/<input type="checkbox" aria-describedby="d-0:0-live-help" checked=""\/>/);
    expect(html).toContain('delivery · Text · live');
  });
});

describe('snippet pages', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const portal = path.resolve(here, '../..');

  it('links Snippets from the site sidebar', () => {
    const layout = fs.readFileSync(path.join(portal, 'layouts/AppLayout.astro'), 'utf8');
    expect(layout).toContain('href={`/app/sites/${siteId}/snippets`}');
  });

  it('opens the editor with the site time zone', () => {
    const page = fs.readFileSync(path.join(portal, 'pages/app/sites/[siteId]/snippets/[snippetId].astro'), 'utf8');
    expect(page).toContain('<SnippetEditor client:load');
    expect(page).toContain('siteTimeZone(settings');
  });
});
