// The workflow detail page hydrates a client:load island, so its props are
// serialized into HTML that every site reader can open. It must send the
// masked projection (workflowSummary), never the raw record that carries the
// WordPress helper key in config.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workflowSummary } from '../../lib/workflows/service';
import type { WorkflowRecord } from '../../lib/workflows/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.resolve(here, '../../pages/app/sites/[siteId]/workflows/[workflowId].astro');

describe('workflow detail page', () => {
  it('hydrates the island with the masked workflow summary', () => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('const initial = workflowSummary(wf)');
    expect(source).toContain('initial={initial}');
    expect(source).not.toMatch(/initial=\{wf\}/);
  });

  it('masks the helper key and drops internal step state in that summary', () => {
    const summary = workflowSummary({
      id: 'wf1', site_id: 's', type: 'migration', status: 'running',
      config: { wp_url: 'https://wp.example', helper_api_key: 'synthetic-helper-key' },
      state: { helper_api_key: 'synthetic-helper-key' },
    } as unknown as WorkflowRecord);
    expect(JSON.stringify(summary)).not.toContain('synthetic-helper-key');
    expect(summary.config).toMatchObject({ wp_url: 'https://wp.example', helper_api_key: '********' });
  });
});
