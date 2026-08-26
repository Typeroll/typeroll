// Regression guard for the "use owner_org_id, not session.orgId" discipline.
//
// Every API route file under pages/api/sites/[siteId]/ must build datastore
// paths from the guard's owner_org_id, not the session's. Using session.orgId
// silently misroutes reads/writes when the site is shared in — the route
// would look at the recipient's empty tree instead of the owner's data, and
// at worst could create stray docs in the wrong tenant.
//
// The check is a literal grep: if `session.orgId` ever reappears inside one
// of these route files, this test fails with a list of the offending lines.
// The fix is either:
//
//   1. Replace `session.orgId` with `owner_org_id` (and add it to the guard
//      destructure if it isn't already).
//   2. If the use is genuinely about *who is acting* (audit log fields,
//      created_by, etc.) — prefer session.userId / session.email instead.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../pages/api/sites/[siteId]');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('site-access org-id discipline', () => {
  it('no route under /api/sites/[siteId] uses session.orgId', () => {
    const offences: string[] = [];
    for (const file of walk(ROOT)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (/\bsession\.orgId\b/.test(line)) {
          offences.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offences, offences.join('\n')).toEqual([]);
  });
});
