// The site fields page's pure helpers: definition editing, error path
// mapping, the opening-hours rows and the request bodies.

import { describe, expect, it } from 'vitest';
import { openingHoursField, validateSiteFieldGroups, validateSiteFieldValues, type SiteFieldGroup } from '@typeroll/shared';
import {
  addException, addFieldTo, addGroup, addOpeningHours, canEditGroup, copyDay, definitionsPutBody, describeProblemPath, describeValue,
  exceptionRows, fieldAt, fieldNameProblem, fieldUsage, groupHasDefinitionErrors, mapDefinitionErrors, mapValueErrors, moveFieldAt,
  openingHoursRows, openingHoursValue, optionsFromText, optionsToText, parseErrorPath, problemsUnder, reindexKeys, removeException,
  removeFieldAt, setDay, suggestGroupId, timeProblem, typeChange, typesAtDepth, updateException, updateFieldAt, updateGroup,
  valuesLostBySave, valuesPatchBody,
} from '../../components/site-fields-model';

const contact: SiteFieldGroup = {
  id: 'contact', label: 'Contact', access: 'editor', fields: [
    { name: 'phone', type: 'text', label: 'Phone' },
    { name: 'show_booking', type: 'boolean', label: 'Show booking' },
    { name: 'team', type: 'array', label: 'Team', fields: [{ name: 'name', type: 'text', label: 'Name' }, { name: 'role', type: 'text', label: 'Role' }] },
  ],
};
const legal: SiteFieldGroup = { id: 'legal', label: 'Legal', access: 'admin', fields: [{ name: 'org_number', type: 'text', label: 'Organisation number' }] };

describe('settings pages', () => {
  it('suggests unique ids from titles', () => {
    expect(suggestGroupId('Contact details', [])).toBe('contact-details');
    expect(suggestGroupId('Contact', ['contact'])).toBe('contact-2');
    expect(suggestGroupId('Öppettider', [])).toBe('oppettider');
    expect(suggestGroupId('2026 offers', [])).toBe('settings-2026-offers');
  });

  it('adds a page open to editors and drops an emptied description', () => {
    const groups = addGroup([contact], 'Contact');
    expect(groups[1]).toEqual({ id: 'contact-2', label: 'Contact', access: 'editor', fields: [] });
    const described = updateGroup(groups, 1, { description: 'Where to reach us' });
    expect(described[1]!.description).toBe('Where to reach us');
    expect('description' in updateGroup(described, 1, { description: '  ' })[1]!).toBe(false);
  });

  it('builds a body the shared validator accepts', () => {
    const body = definitionsPutBody([{ ...contact, label: ' Contact ', description: ' ' }], 'T1');
    expect(body.expected_updated_at).toBe('T1');
    expect(body.groups[0]!.label).toBe('Contact');
    expect('description' in body.groups[0]!).toBe(false);
    expect(validateSiteFieldGroups(body.groups).errors).toEqual([]);
    expect(definitionsPutBody([contact], undefined)).not.toHaveProperty('expected_updated_at');
  });
});

describe('field definitions', () => {
  it('adds a field with a name unique across the site, nested ones unique in their list', () => {
    const first = addFieldTo([contact, legal], 1, [], { label: 'Phone' });
    expect(first.path).toEqual([1]);
    expect(fieldAt(first.groups[1]!.fields, first.path)!.name).toBe('phone_2');
    const nested = addFieldTo([contact], 0, [2], { label: 'Phone' });
    expect(nested.path).toEqual([2, 2]);
    expect(fieldAt(nested.groups[0]!.fields, nested.path)).toMatchObject({ name: 'phone', type: 'text' });
  });

  it('updates, moves and removes nested fields by path', () => {
    let fields = updateFieldAt(contact.fields, [2, 1], { label: 'Title', help: '' });
    expect(fieldAt(fields, [2, 1])).toEqual({ name: 'role', type: 'text', label: 'Title' });
    fields = moveFieldAt(fields, [2, 1], -1);
    expect(fieldAt(fields, [2])!.fields!.map((field) => field.name)).toEqual(['role', 'name']);
    fields = removeFieldAt(fields, [0]);
    expect(fields.map((field) => field.name)).toEqual(['show_booking', 'team']);
    // Moving past either end changes nothing.
    expect(moveFieldAt(fields, [0], -1)).toEqual(fields);
  });

  it('inserts opening hours with a free name', () => {
    const once = addOpeningHours([contact], 0);
    expect(fieldAt(once.groups[0]!.fields, once.path)).toEqual(openingHoursField());
    const twice = addOpeningHours(once.groups, 0);
    expect(fieldAt(twice.groups[0]!.fields, twice.path)!.name).toBe('opening_hours_2');
    expect(validateSiteFieldGroups(twice.groups).errors).toEqual([]);
  });

  it('checks names before saving', () => {
    expect(fieldNameProblem('Phone', [])).toMatch(/lowercase/);
    expect(fieldNameProblem('phone', ['phone'])).toMatch(/already used/);
    expect(fieldNameProblem('phone_2', ['phone'])).toBeNull();
  });

  it('changes type and drops what the new type has no use for', () => {
    expect(typeChange({ name: 'kind', type: 'text', label: 'Kind', placeholder: 'x' }, 'select')).toMatchObject({ type: 'select', options: ['option_1', 'option_2'], placeholder: undefined });
    const toText = typeChange(contact.fields[2]!, 'text');
    expect(toText).toMatchObject({ fields: undefined, item_label: undefined, min_items: undefined });
    expect(typeChange({ name: 'n', type: 'number', label: 'N', min: 1 }, 'array')).toMatchObject({ min: undefined, fields: [{ name: 'title', type: 'text', label: 'Title' }] });
    expect(typesAtDepth(3)).not.toContain('array');
    expect(typesAtDepth(2)).toContain('object');
  });

  it('reads and writes choice options as lines', () => {
    expect(optionsToText({ options: ['a', 'b'], option_labels: ['Alpha', 'b'] })).toBe('a | Alpha\nb');
    expect(optionsFromText('a | Alpha\n\n b ')).toEqual({ options: ['a', 'b'], labels: ['Alpha', 'b'] });
    expect(optionsFromText('a\nb')).toEqual({ options: ['a', 'b'], labels: undefined });
  });

  it('keeps open fields open when the list changes', () => {
    const open = new Set(['0:0', '0:2', '0:2.1', '1:0']);
    expect([...reindexKeys(open, 0, [], (i) => (i === 0 ? 2 : i === 2 ? 0 : i))].sort()).toEqual(['0:0', '0:0.1', '0:2', '1:0']);
    expect([...reindexKeys(open, 0, [], (i) => (i === 0 ? null : i - 1))].sort()).toEqual(['0:1', '0:1.1', '1:0']);
    expect([...reindexKeys(open, 0, [2], (i) => (i === 1 ? 0 : i))].sort()).toEqual(['0:0', '0:2', '0:2.0', '1:0']);
  });

  it('lists the saved values a definitions save would delete', () => {
    const after: SiteFieldGroup[] = [{ ...contact, fields: [{ ...contact.fields[0]!, name: 'telephone' }, contact.fields[1]!] }];
    expect(valuesLostBySave([contact], after, { phone: '+46 8 123', show_booking: false, team: [] }))
      .toEqual([{ name: 'phone', label: 'Phone' }]);
    expect(valuesLostBySave([contact], [contact], { phone: '1' })).toEqual([]);
  });
});

describe('error paths', () => {
  it('parses dotted and indexed paths', () => {
    expect(parseErrorPath('groups[0].fields[1].fields[2].name')).toEqual(['groups', 0, 'fields', 1, 'fields', 2, 'name']);
    expect(parseErrorPath('opening_hours.days[3].opens')).toEqual(['opening_hours', 'days', 3, 'opens']);
  });

  it('puts definition errors on their page and field', () => {
    const { errors } = validateSiteFieldGroups([
      { id: 'Bad id', label: '', fields: [{ name: 'Phone', type: 'text', label: 'Phone' }, { name: 'list', type: 'array', label: 'List', fields: [{ name: 'x', type: 'nope', label: 'X' }] }] },
    ]);
    const mapped = mapDefinitionErrors([...errors, { path: 'groups', message: 'At most 20 settings pages' }]);
    expect(mapped.general).toEqual(['At most 20 settings pages']);
    expect(mapped.byKey.get('0')!.map((problem) => problem.property).sort()).toEqual(['id', 'label']);
    expect(mapped.byKey.get('0:0')).toEqual([{ property: 'name', message: expect.stringMatching(/lowercase/) }]);
    expect(mapped.byKey.get('0:1.0')).toEqual([{ property: 'type', message: expect.any(String) }]);
    expect(groupHasDefinitionErrors(mapped, 0)).toBe(true);
    expect(groupHasDefinitionErrors(mapped, 1)).toBe(false);
  });

  it('puts value errors on the top-level field with the rest of the path', () => {
    const hours = openingHoursField();
    const { errors } = validateSiteFieldValues([{ id: 'g', label: 'G', fields: [hours, { name: 'email', type: 'email', label: 'Email' }] }], {
      email: 'nope', opening_hours: { days: [], exceptions: [{ closed: true }] }, ghost: 1,
    });
    const mapped = mapValueErrors(errors);
    expect(mapped.get('email')).toEqual([{ path: '', message: 'Not an email address' }]);
    expect(mapped.get('ghost')).toEqual([{ path: '', message: 'No site field is called ghost' }]);
    const hourProblems = mapped.get('opening_hours')!;
    expect(hourProblems.map((problem) => problem.path)).toEqual(expect.arrayContaining(['days', 'exceptions[0].date']));
    expect(problemsUnder(hourProblems, 'exceptions[0]')).toEqual([{ path: 'date', message: 'Date is required' }]);
    expect(describeProblemPath(hours, 'exceptions[0].date')).toBe('Exceptions › item 1 › Date');
    expect(mapValueErrors([{ path: 'values', message: 'values is an object' }]).get('')).toEqual([{ path: 'values', message: 'values is an object' }]);
  });
});

describe('values', () => {
  it('sends every field of the page, emptied ones as null', () => {
    expect(valuesPatchBody(contact, { phone: '', show_booking: true, team: [], other: 'x' }, 'T2')).toEqual({
      values: { phone: null, show_booking: true, team: null }, expected_updated_at: 'T2',
    });
  });

  it('lets editors change editor pages and only admins change admin pages', () => {
    expect(canEditGroup(contact, 'write')).toBe(true);
    expect(canEditGroup(legal, 'write')).toBe(false);
    expect(canEditGroup(legal, 'admin')).toBe(true);
    expect(canEditGroup(contact, 'read')).toBe(false);
  });

  it('describes stored values for reading', () => {
    expect(describeValue(contact.fields[1]!, false)).toBe('No');
    expect(describeValue(contact.fields[0]!, '')).toBe('—');
    expect(describeValue({ name: 's', type: 'select', label: 'S', options: ['a'], option_labels: ['Alpha'] }, 'a')).toBe('Alpha');
    expect(describeValue(contact.fields[2]!, [{ name: 'Ada' }])).toBe('1 item');
    expect(describeValue({ name: 'r', type: 'richtext', label: 'R' }, '<p>Hi <b>there</b></p>')).toBe('Hi there');
  });

  it('says how a template uses each field', () => {
    expect(fieldUsage(contact.fields[0]!).placeholder).toBe('{{site.fields.phone}}');
    expect(fieldUsage(contact.fields[1]!).condition).toBe('site.fields.show_booking');
    expect(fieldUsage(openingHoursField()).hint).toMatch(/Site field block/);
  });
});

describe('opening hours rows', () => {
  it('always shows seven days, Monday first', () => {
    const rows = openingHoursRows({ days: [{ day: 'sunday', closed: true }, { day: 'monday', opens: '09:00', closes: '17:00' }] });
    expect(rows.map((row) => row.day)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(rows[0]).toEqual({ day: 'monday', closed: false, opens: '09:00', closes: '17:00' });
    expect(rows[6]!.closed).toBe(true);
    expect(openingHoursRows(undefined)).toHaveLength(7);
  });

  it('stores a value the shared validator accepts', () => {
    let value = setDay(undefined, 'monday', { opens: '09:00', closes: '17:00' });
    value = copyDay(value, 'monday', ['tuesday', 'wednesday']);
    value = setDay(value, 'sunday', { closed: true, opens: '10:00' });
    value = addException(value, '2026-12-24');
    value = updateException(value, 0, { note: 'Christmas Eve' });
    expect(value.days![2]).toEqual({ day: 'wednesday', closed: false, opens: '09:00', closes: '17:00' });
    expect(value.days![6]).toEqual({ day: 'sunday', closed: true });
    expect(value.exceptions).toEqual([{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }]);
    const groups = [{ id: 'g', label: 'G', fields: [openingHoursField()] }];
    expect(validateSiteFieldValues(groups, { opening_hours: value }).errors).toEqual([]);
    expect(exceptionRows(removeException(value, 0))).toEqual([]);
    expect(openingHoursValue(openingHoursRows(value), exceptionRows(value))).toEqual(value);
  });

  it('points out times that cannot work', () => {
    expect(timeProblem({ closed: false, opens: '', closes: '' })).toBeNull();
    expect(timeProblem({ closed: true, opens: '25:00', closes: '' })).toBeNull();
    expect(timeProblem({ closed: false, opens: '09:00', closes: '' })).toMatch(/both/);
    expect(timeProblem({ closed: false, opens: '9am', closes: '17:00' })).toMatch(/24-hour/);
    expect(timeProblem({ closed: false, opens: '17:00', closes: '09:00' })).toMatch(/before/);
    expect(timeProblem({ closed: false, opens: '09:00', closes: '17:00' })).toBeNull();
  });
});
