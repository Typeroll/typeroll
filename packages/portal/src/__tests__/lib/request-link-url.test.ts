// Regression guard: the emailed edit link must point at a route that exists.
//
// The bug this pins: request-link.ts built the link as
// `/api/directory/{siteId}/redeem`, but nothing implements `/redeem` — the
// redeem step is `GET /api/directory/{siteId}/session?t=<token>`. Every mailed
// link 404'd, which broke the directory app's whole owner-editing flow.
//
// It survived review and a green suite because the session tests import the
// route module and call `GET(...)` directly, so Astro's file-based routing is
// never involved. This test closes that gap the only way that actually works
// for file-based routing: resolve the emitted path against the pages directory
// on disk.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EDIT_LINK_PATH } from '../../pages/api/directory/[siteId]/request-link';

const PAGES_ROOT = path.resolve(__dirname, '../../pages');

/**
 * Map a request path to the Astro route file that would serve it, substituting
 * any concrete segment for a `[param]` directory when no literal match exists.
 */
function routeFileFor(urlPath: string): string | null {
  const segments = urlPath.replace(/^\/+/, '').split('/');
  let dir = PAGES_ROOT;

  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const seg = segments[i];
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

    if (isLast) {
      const file = entries.find((e) => e === `${seg}.ts` || e === `${seg}.astro`);
      if (file) return path.join(dir, file);
      // A dynamic leaf (e.g. [pageId].ts) also serves this path.
      const dynamic = entries.find((e) => /^\[.+\]\.(ts|astro)$/.test(e));
      return dynamic ? path.join(dir, dynamic) : null;
    }

    const literal = entries.find((e) => e === seg && fs.statSync(path.join(dir, e)).isDirectory());
    const dynamic = entries.find(
      (e) => /^\[.+\]$/.test(e) && fs.statSync(path.join(dir, e)).isDirectory(),
    );
    const next = literal ?? dynamic;
    if (!next) return null;
    dir = path.join(dir, next);
  }
  return null;
}

describe('the emailed edit link', () => {
  it('points at a route file that exists', () => {
    const file = routeFileFor(EDIT_LINK_PATH('any-site'));
    expect(file, `no route file serves ${EDIT_LINK_PATH('any-site')}`).not.toBeNull();
    expect(fs.existsSync(file!)).toBe(true);
  });

  it('resolves to the session route, which is what redeems a grant', () => {
    const file = routeFileFor(EDIT_LINK_PATH('any-site'))!;
    expect(path.basename(file)).toBe('session.ts');
    // The route must actually implement the redeem verb the link relies on.
    expect(fs.readFileSync(file, 'utf8')).toMatch(/export const GET/);
  });

  it('would have failed on the old /redeem path', () => {
    // Proves the helper detects a missing route rather than passing vacuously.
    expect(routeFileFor('/api/directory/any-site/redeem')).toBeNull();
  });
});
