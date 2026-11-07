import { describe, expect, it } from 'vitest';
import { hoursAhead, hoursOn, openingHoursField, openingStatus, validateSiteFieldGroups, validateSiteFieldValues, type OpeningHours } from '../site-fields.js';

const groups = [
  { id: 'contact', label: 'Contact', fields: [
    { name: 'show_booking', type: 'boolean', label: 'Show the booking calendar' },
    { name: 'address', type: 'textarea', label: 'Visiting address' },
    { name: 'delivery_days', type: 'number', label: 'Delivery days right now', min: 0, max: 60 },
    { name: 'season', type: 'select', label: 'Season', options: ['summer', 'winter'] },
  ] },
  { id: 'hours', label: 'Opening hours', access: 'admin', fields: [openingHoursField()] },
];

describe('site field definitions', () => {
  it('accepts settings pages and keeps their access', () => {
    const { groups: valid, errors } = validateSiteFieldGroups(groups);
    expect(errors).toEqual([]);
    expect(valid.map((group) => [group.id, group.access])).toEqual([['contact', 'editor'], ['hours', 'admin']]);
  });

  it('refuses duplicate names across the site, bad types and empty options', () => {
    const { errors } = validateSiteFieldGroups([
      { id: 'a', label: 'A', fields: [{ name: 'x', type: 'text', label: 'X' }, { name: 'Bad Name', type: 'text', label: 'B' }] },
      { id: 'a', label: '', fields: [{ name: 'x', type: 'html', label: 'Y' }, { name: 'z', type: 'select', label: 'Z' }, { name: 'l', type: 'array', label: 'L' }] },
    ]);
    expect(errors.map((error) => error.path)).toEqual(expect.arrayContaining([
      'groups[0].fields[1].name', 'groups[1].id', 'groups[1].label', 'groups[1].fields[0].name', 'groups[1].fields[0].type', 'groups[1].fields[1].options', 'groups[1].fields[2].fields',
    ]));
  });
});

describe('site field values', () => {
  const { groups: valid } = validateSiteFieldGroups(groups);

  it('checks and coerces values, and reports unknown names', () => {
    const { values, errors } = validateSiteFieldValues(valid, { show_booking: true, delivery_days: '3', season: 'winter', address: 'Storgatan 1', nope: 1 });
    expect(values).toEqual({ show_booking: true, delivery_days: 3, season: 'winter', address: 'Storgatan 1' });
    expect(errors).toEqual([{ path: 'nope', message: 'No site field is called nope' }]);
  });

  it('refuses wrong types and out-of-range numbers with their paths', () => {
    const { errors } = validateSiteFieldValues(valid, { show_booking: 'yes', delivery_days: 99, season: 'spring', opening_hours: { days: [{ day: 'funday' }] } });
    expect(errors.map((error) => error.path)).toEqual(['show_booking', 'delivery_days', 'season', 'opening_hours.days']);
  });

  it('can check one settings page at a time', () => {
    expect(validateSiteFieldValues(valid, { show_booking: false }, ['contact']).values).toEqual({ show_booking: false });
  });
});

describe('opening hours', () => {
  const hours: OpeningHours = {
    days: [
      { day: 'monday', opens: '09:00', closes: '17:00' }, { day: 'tuesday', opens: '9:00', closes: '17:00' },
      { day: 'wednesday', opens: '09:00', closes: '17:00' }, { day: 'thursday', opens: '09:00', closes: '19:00' },
      { day: 'friday', opens: '09:00', closes: '16:00' }, { day: 'saturday', opens: '10:00', closes: '14:00' }, { day: 'sunday', closed: true },
    ],
    exceptions: [{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }],
  };

  it('uses the weekday, normalises times and lets a dated exception win', () => {
    expect(hoursOn(hours, '2026-11-10', 'tuesday')).toMatchObject({ closed: false, opens: '09:00', closes: '17:00' });
    expect(hoursOn(hours, '2026-12-24', 'thursday')).toMatchObject({ closed: true, exception: true, note: 'Christmas Eve' });
    expect(hoursOn(hours, '2026-11-08', 'sunday').closed).toBe(true);
  });

  it('knows whether it is open now and when it next opens, in the site time zone', () => {
    // Saturday 7 November 2026, 11:30 in Stockholm (10:30 UTC).
    expect(openingStatus(hours, new Date('2026-11-07T10:30:00Z'), 'Europe/Stockholm')).toEqual({ open: true, until: '14:00' });
    // Saturday 15:00 in Stockholm: closed; Sunday closed; next is Monday.
    const later = openingStatus(hours, new Date('2026-11-07T14:00:00Z'), 'Europe/Stockholm');
    expect(later.open).toBe(false);
    expect(later.next).toMatchObject({ weekday: 'monday', opens: '09:00' });
    expect(hoursAhead(hours, new Date('2026-11-07T10:30:00Z'), 3, 'Europe/Stockholm').map((day) => day.weekday)).toEqual(['saturday', 'sunday', 'monday']);
  });
});

describe('siteTimeZone', () => {
  it('uses the site setting, then the language, then Stockholm', async () => {
    const { siteTimeZone } = await import('../site-display-settings.js');
    expect(siteTimeZone({ time_zone: 'Europe/Oslo', language: 'sv' })).toBe('Europe/Oslo');
    expect(siteTimeZone({ language: 'nb' })).toBe('Europe/Oslo');
    expect(siteTimeZone({ language: 'en-GB' })).toBe('Europe/London');
    expect(siteTimeZone({ language: 'fi-FI' })).toBe('Europe/Helsinki');
    expect(siteTimeZone({ language: 'en' })).toBe('Europe/Stockholm');
    expect(siteTimeZone({ time_zone: 'Mars/Olympus', language: 'da' })).toBe('Europe/Copenhagen');
    expect(siteTimeZone(undefined)).toBe('Europe/Stockholm');
  });
});

describe('opening hours with a break and comments', () => {
  const hours: OpeningHours = {
    days: [{ day: 'monday', opens: '09:00', closes: '17:00', break_starts: '12:00', break_ends: '13:00', note: 'Lunch closed 12–13' }],
    exceptions: [{ date: '2026-11-16', opens: '10:00', closes: '14:00', note: 'Staff day' }],
    note: 'Lunch closed 12–13 on weekdays',
  };

  it('keeps a break inside the day and the weekday comment; an exception comment wins', () => {
    expect(hoursOn(hours, '2026-11-09', 'monday')).toMatchObject({ break: { starts: '12:00', ends: '13:00' }, note: 'Lunch closed 12–13' });
    expect(hoursOn(hours, '2026-11-16', 'monday')).toMatchObject({ opens: '10:00', closes: '14:00', note: 'Staff day', exception: true });
    expect(hoursOn({ days: [{ day: 'monday', opens: '09:00', closes: '17:00', break_starts: '18:00', break_ends: '19:00' }] }, '2026-11-09', 'monday').break).toBeUndefined();
  });

  it('is closed during the break and opens again when it ends', () => {
    // Monday 9 November 2026 in Stockholm (UTC+1).
    expect(openingStatus(hours, new Date('2026-11-09T10:30:00Z'), 'Europe/Stockholm')).toEqual({ open: true, until: '12:00' });
    expect(openingStatus(hours, new Date('2026-11-09T11:30:00Z'), 'Europe/Stockholm')).toMatchObject({ open: false, next: { weekday: 'monday', opens: '13:00' } });
    expect(openingStatus(hours, new Date('2026-11-09T12:30:00Z'), 'Europe/Stockholm')).toEqual({ open: true, until: '17:00' });
  });
});
