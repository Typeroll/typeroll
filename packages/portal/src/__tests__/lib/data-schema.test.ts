import { expect, it } from 'vitest';
import { validateInstalledDataSchema } from '../../lib/data-schema';

it('refuses missing, old and future schemas, including an expired migration lock', () => {
  for (const value of [null, {}, { data_schema_version: 1 }, { data_schema_version: 3 }]) {
    expect(() => validateInstalledDataSchema(value)).toThrow('must be migrated');
  }
  expect(() => validateInstalledDataSchema({ data_schema_version: 2, migration_lock: { expires_at: '2000-01-01' } })).toThrow('in progress');
  expect(() => validateInstalledDataSchema({ data_schema_version: 2 })).not.toThrow();
});
