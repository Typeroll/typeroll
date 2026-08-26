// The `site` slice of a render context.
//
// `{{site.name}}` is what the core template blocks bind and what the docs
// promise, but SiteSettings stores `site_name`. Every caller used to pass the
// settings doc verbatim, so template/site_title rendered an empty heading and
// template/site_logo an empty alt — silently, on the live site and in the
// portal preview alike. These tests pin the mapping and the properties that
// keep it from breaking something else.

import { describe, it, expect } from 'vitest';
import { renderBlocks, siteContext, buildCoreBlockRegistry } from '../index.js';

describe('siteContext', () => {
  it('exposes site_name as name — the token the core blocks actually bind', () => {
    expect(siteContext({ site_name: 'ACME Studio' }).name).toBe('ACME Studio');
  });

  it('keeps every other settings field reachable', () => {
    const ctx = siteContext({ site_name: 'ACME', tagline: 'We build', logo: '/logo.svg' });
    expect(ctx.tagline).toBe('We build');
    expect(ctx.logo).toBe('/logo.svg');
  });

  it('keeps site_name itself reachable', () => {
    // A site that worked around the bug with {{site.site_name}} must not break
    // when the alias lands.
    expect(siteContext({ site_name: 'ACME' }).site_name).toBe('ACME');
  });

  it('yields an empty string rather than undefined when there is no name', () => {
    // An unresolved token renders empty anyway; returning undefined would only
    // differ if a caller started testing truthiness on the context itself.
    expect(siteContext({}).name).toBe('');
    expect(siteContext(null).name).toBe('');
    expect(siteContext(undefined).name).toBe('');
  });

  it('does not mutate the settings object it was given', () => {
    const settings = { site_name: 'ACME' };
    siteContext(settings);
    expect('name' in settings).toBe(false);
  });

  it('makes template/site_title render the site name end to end', () => {
    const html = renderBlocks(
      [{ id: 'b1', type: 'template/site_title', data: { level: 'h1', size: 'xl' } }],
      {
        registry: buildCoreBlockRegistry(),
        context: { site: siteContext({ site_name: 'ACME Studio' }) },
      },
    );
    expect(html).toContain('ACME Studio');
  });

  it('renders an empty title when the raw settings doc is passed instead', () => {
    // The bug, pinned: this is what every call site did before, and nothing
    // about it looks wrong at the call site.
    const html = renderBlocks(
      [{ id: 'b1', type: 'template/site_title', data: { level: 'h1', size: 'xl' } }],
      {
        registry: buildCoreBlockRegistry(),
        context: { site: { site_name: 'ACME Studio' } },
      },
    );
    expect(html).not.toContain('ACME Studio');
  });
});
