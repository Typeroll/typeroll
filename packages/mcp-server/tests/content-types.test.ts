import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contentTypeTools } from '../src/tools/content-types.js';

const schema = z.object(contentTypeTools.find(tool => tool.name === 'create_content_type')!.inputSchema!);
const input = { name: 'suppliers', label_singular: 'Supplier', label_plural: 'Suppliers', route_template: '/companies/{slug}', fields: [
  { name: 'email', label: 'Email', type: 'email', rendered: false },
  { name: 'website', label: 'Website', type: 'url' },
  { name: 'seasons', label: 'Seasons', type: 'multiselect', options: ['spring', 'fall'] },
] };
describe('content type wire contract', () => {
  it('passes directory fields and field-name tuples without converting their shape', () => {
    const body = { ...input, facet_combinations: [['category', 'state']], schema_field_mode: 'mapped' };
    expect(schema.parse(body)).toEqual(body);
  });
  it('rejects ambiguous records, malformed tuples and unknown field types', () => {
    for (const facet_combinations of [[{ category: 'state' }], [['category']], [['a', 'b', 'c']]]) expect(schema.safeParse({ ...input, facet_combinations }).success).toBe(false);
    expect(schema.safeParse({ ...input, fields: [{ name: 'bad', label: 'Bad', type: 'multi_select' }] }).success).toBe(false);
  });
});
