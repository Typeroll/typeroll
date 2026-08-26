import { describe, it, expect } from 'vitest';
import {
  classifyHostname,
  isValidHostname,
  normalizeHostname,
  pickCanonical,
  siblingOf,
} from '../../lib/domain-pair';

describe('normalizeHostname', () => {
  it('lowercases, strips protocol/path/port/trailing dot', () => {
    expect(normalizeHostname('  HTTPS://Example.COM/foo?q=1  ')).toBe('example.com');
    expect(normalizeHostname('http://www.example.com:8080/')).toBe('www.example.com');
    expect(normalizeHostname('example.com.')).toBe('example.com');
  });
});

describe('isValidHostname', () => {
  it('accepts common forms', () => {
    expect(isValidHostname('example.com')).toBe(true);
    expect(isValidHostname('www.example.com')).toBe(true);
    expect(isValidHostname('app.example.com')).toBe(true);
    expect(isValidHostname('autopilot.se')).toBe(true);
  });
  it('rejects malformed forms', () => {
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('example')).toBe(false);
    expect(isValidHostname('.example.com')).toBe(false);
    expect(isValidHostname('example..com')).toBe(false);
    expect(isValidHostname('example.com/')).toBe(false);
  });
});

describe('classifyHostname', () => {
  it('classifies a bare 2-label hostname as apex', () => {
    const c = classifyHostname('autopilot.se');
    expect(c.kind).toBe('apex');
    expect(c.apex).toBe('autopilot.se');
    expect(c.www).toBe('www.autopilot.se');
  });

  it('classifies www.<apex> as www and derives the apex', () => {
    const c = classifyHostname('www.autopilot.se');
    expect(c.kind).toBe('www');
    expect(c.apex).toBe('autopilot.se');
    expect(c.www).toBe('www.autopilot.se');
  });

  it('classifies app.<apex> as subdomain (no sibling derived)', () => {
    const c = classifyHostname('app.example.com');
    expect(c.kind).toBe('subdomain');
    expect(c.apex).toBeNull();
    expect(c.www).toBeNull();
  });

  it('treats 3-label public-suffix-ish hostnames as subdomain (PSL-safe)', () => {
    // example.co.uk has 3 labels but is a registrable apex on PSL. We
    // deliberately classify as subdomain so we don't derive `co.uk` as a
    // sibling. Customers on these TLDs add both variants by hand.
    const c = classifyHostname('example.co.uk');
    expect(c.kind).toBe('subdomain');
    expect(c.apex).toBeNull();
    expect(c.www).toBeNull();
  });

  it('handles 4-label www.example.co.uk by NOT cross-zoning', () => {
    // 4 labels, starts with www — still subdomain because the apex
    // derivation would land at example.co.uk which we can't validate
    // without the PSL. Better to under-register than cross zones.
    const c = classifyHostname('www.example.co.uk');
    expect(c.kind).toBe('subdomain');
  });

  it('normalizes the input', () => {
    const c = classifyHostname('  HTTPS://Example.COM/  ');
    expect(c.kind).toBe('apex');
    expect(c.hostname).toBe('example.com');
  });

  it('returns subdomain for invalid input (with the raw normalized hostname)', () => {
    const c = classifyHostname('not-a-domain');
    expect(c.kind).toBe('subdomain');
    expect(c.apex).toBeNull();
  });
});

describe('siblingOf', () => {
  it('apex → www', () => {
    expect(siblingOf('autopilot.se')).toBe('www.autopilot.se');
  });
  it('www → apex', () => {
    expect(siblingOf('www.autopilot.se')).toBe('autopilot.se');
  });
  it('subdomain → null', () => {
    expect(siblingOf('app.example.com')).toBeNull();
  });
  it('co.uk-style → null', () => {
    expect(siblingOf('example.co.uk')).toBeNull();
  });
});

describe('pickCanonical', () => {
  it('apex input + prefer apex → apex canonical, www alias', () => {
    const p = pickCanonical('autopilot.se', 'apex');
    expect(p.canonical).toBe('autopilot.se');
    expect(p.alias).toBe('www.autopilot.se');
    expect(p.registrations).toEqual(['autopilot.se', 'www.autopilot.se']);
  });

  it('www input + prefer apex → still apex canonical', () => {
    // Input doesn't drive canonical — preference does. User typing
    // www.autopilot.se should still result in apex being canonical
    // (with the existing platform default of prefer="apex").
    const p = pickCanonical('www.autopilot.se', 'apex');
    expect(p.canonical).toBe('autopilot.se');
    expect(p.alias).toBe('www.autopilot.se');
  });

  it('apex input + prefer www → www canonical, apex alias', () => {
    const p = pickCanonical('autopilot.se', 'www');
    expect(p.canonical).toBe('www.autopilot.se');
    expect(p.alias).toBe('autopilot.se');
    expect(p.registrations).toEqual(['www.autopilot.se', 'autopilot.se']);
  });

  it('subdomain input → no sibling, single registration', () => {
    const p = pickCanonical('app.example.com', 'apex');
    expect(p.canonical).toBe('app.example.com');
    expect(p.alias).toBeNull();
    expect(p.registrations).toEqual(['app.example.com']);
  });

  it('canonical is always first in registrations', () => {
    const p1 = pickCanonical('autopilot.se', 'apex');
    expect(p1.registrations[0]).toBe(p1.canonical);
    const p2 = pickCanonical('autopilot.se', 'www');
    expect(p2.registrations[0]).toBe(p2.canonical);
  });
});
