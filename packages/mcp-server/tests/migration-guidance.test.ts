import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILLS } from '../src/bundled-content.js';

describe('distributed migration workflow safety', () => {
  it.each(['tr-migrate-wp', 'tr-migrate-multisite', 'tr-migrate-astro', 'tr-import-url'])('%s exposes the source evidence gate before its recipe', name => {
    const skill = BUNDLED_SKILLS[name];
    expect(skill).toBeTruthy();
    expect(skill.indexOf('tr-migration-evidence')).toBeGreaterThan(0);
    expect(skill.indexOf('tr-migration-evidence')).toBeLessThan(skill.indexOf('\n## '));
  });
  it('ships the evidence recipe, including rejected technical-only acceptance and round-trip detection', () => {
    const skill = BUNDLED_SKILLS['tr-migration-evidence'];
    expect(skill).toContain('HTTP 200, no overflow, all content is blocks');
    expect(skill).toContain('FAIL: brand/layout lost');
    expect(skill).toContain('computed size stays 32');
    expect(skill).toContain('PASS: deliberate improvement in mobile usability');
    expect(skill).toContain('booleans are reviewer attestations, not automated visual proof');
  });
  it('requires typed values and verifies native CTA semantics after conversion', () => {
    const skill = BUNDLED_SKILLS['tr-migration-evidence'];
    expect(skill).toContain('number fields use JSON numbers');
    expect(skill).toContain('not strings');
    expect(skill).toContain('affiliate queries/fragments');
    expect(skill).toContain('actual tab opening');
    expect(skill).toContain('without requiring');
    expect(skill).toContain('source `sponsored`/`nofollow`');
    expect(skill).toContain('stop for native support');
  });
  it('does not prescribe blanket archive redirects, early domain attachment or real test leads', () => {
    const guides = ['tr-migrate-wp', 'tr-migrate-multisite'].map(name => BUNDLED_SKILLS[name]).join('\n');
    expect(guides).not.toMatch(/create_redirect[^\n]*from_path="\/(?:category|tag|2019)\/\*"/);
    expect(guides).not.toContain('Submit a real test through every form');
    expect(guides).not.toMatch(/create_site[^\n]*domain=/);
    expect(guides).toContain('Never automatically mark source 404s');
  });
});
