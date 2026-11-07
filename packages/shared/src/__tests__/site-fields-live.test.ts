// Live site fields: `live: true` is kept on top-level fields only, and not
// on a field with a list inside a list (opening hours qualifies).

import { describe, expect, it } from 'vitest';
import { liveSiteFieldNames, openingHoursField, validateSiteFieldGroups } from '../index.js';

const group = (fields: unknown[]) => [{ id: 'live', label: 'Live', fields }];

describe('live site fields', () => {
  it('keeps live on top-level fields, including opening hours, and drops false', () => {
    const { groups, errors } = validateSiteFieldGroups(group([
      { name: 'delivery_days', type: 'number', label: 'Delivery days', live: true },
      { ...openingHoursField(), live: true },
      { name: 'notice', type: 'text', label: 'Notice', live: false },
    ]));
    expect(errors).toEqual([]);
    expect(liveSiteFieldNames(groups)).toEqual(['delivery_days', 'opening_hours']);
    expect(groups[0]!.fields[2]).not.toHaveProperty('live');
  });

  it('refuses live on nested fields, deep structures and non-booleans', () => {
    const { errors } = validateSiteFieldGroups(group([
      { name: 'team', type: 'array', label: 'Team', fields: [{ name: 'person', type: 'text', label: 'Person', live: true }] },
      { name: 'deep', type: 'array', label: 'Deep', live: true, fields: [
        { name: 'inner', type: 'array', label: 'Inner', fields: [{ name: 'x', type: 'text', label: 'X' }] },
      ] },
      { name: 'odd', type: 'text', label: 'Odd', live: 'yes' },
    ]));
    expect(errors.map((error) => error.path)).toEqual([
      'groups[0].fields[0].fields[0].live', 'groups[0].fields[1].live', 'groups[0].fields[2].live',
    ]);
  });
});
