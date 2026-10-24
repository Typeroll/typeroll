import { expect, it } from 'vitest';
import { z } from 'zod';

it('rejects an oversized constrained collection before parsing its elements', () => {
  let parsed = 0;
  const schema = z.array(z.string().refine(() => { parsed++; return false; })).max(4);
  const result = schema.safeParse(Array(10000).fill('invalid'));
  expect(result.success).toBe(false);
  expect(parsed).toBe(0);
  expect(result.error?.issues).toHaveLength(1);
  expect(result.error?.issues[0].code).toBe('too_big');
});
