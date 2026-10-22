import { expect, it } from 'vitest';
import { schemaDate } from '../schema-dates.js';
import { buildContentPageSchema } from '../schema-generators.js';

it('preserves explicit instants and calendar dates without guessing a legacy timezone', () => {
  for (const value of ['2024-05-02T10:01:08Z', '2024-05-02T11:01:08+01:00', '2024-05-02T10:01:08.123Z', '2024-05-02']) {
    expect(schemaDate(value)).toBe(value);
  }
  expect(schemaDate('2024-05-02T11:01:08')).toBe('2024-05-02');
  for (const value of ['', null, '0000-00-00T00:00:00Z', '2024-02-30', '2024-05-02T99:01:08Z', 'not a date']) {
    expect(schemaDate(value)).toBeUndefined();
  }
});

it('normalizes mapped and automatic Article dates consistently', () => {
  const page = { title: 'Example', fields: { published: '2024-05-02T11:01:08+01:00' },
    date_published: '2024-05-02T10:01:08Z', date_updated: '2024-05-03T11:01:08' } as never;
  const type = { schema_type: 'Article', fields: [], schema_field_map: { published: 'datePublished' } } as never;
  const mapped = JSON.parse(buildContentPageSchema(page, type, {} as never, 'https://example.test/article/')!);
  expect(mapped.datePublished).toBe('2024-05-02T11:01:08+01:00');
  expect(mapped.dateModified).toBe('2024-05-03');
  const automatic = JSON.parse(buildContentPageSchema({ ...page as object, fields: {} } as never, type, {} as never, 'https://example.test/article/')!);
  expect(automatic.datePublished).toBe('2024-05-02T10:01:08Z');
});
