import { describe, expect, it } from 'vitest';
import { auditMigrationScripts, scriptAuditIssues } from '../../lib/migration-script-audit';

const audit = (input: Partial<Parameters<typeof auditMigrationScripts>[0]>) =>
  auditMigrationScripts({ settings: {}, apps: null, sources: [], ...input });

describe('migration script audit', () => {
  it('flags WordPress plugin, theme and jQuery scripts wherever they were copied', () => {
    const findings = audit({
      settings: { scripts_body_end: '<script src="https://old.example.se/wp-content/plugins/slider/slider.min.js"></script>' } as never,
      sources: [
        { location: 'page:/om-oss/', html: JSON.stringify({ blocks: [{ data: { html: '<script>jQuery(function($){ $(".x").slick(); });</script>' } }] }) },
        { location: 'partial:footer', html: '<script>var _wpemojiSettings = {};</script>' },
        { location: 'block_type:popup', script: 'fetch(ajaxurl, { method: "POST" })' },
      ],
    });
    expect(findings.map(f => [f.id, f.location])).toEqual([
      ['source_runtime_script', 'settings.scripts_body_end'],
      ['source_runtime_script', 'page:/om-oss/'],
      ['source_runtime_script', 'partial:footer'],
      ['source_runtime_script', 'block_type:popup'],
    ]);
  });

  it('ignores markup that only mentions a plugin outside a script', () => {
    expect(audit({ sources: [{ location: 'page:/', html: '<div class="elementor-widget wpcf7-form">Copied markup</div>' }] })).toEqual([]);
  });

  it('allows own scripts that are not the source runtime or a tracker', () => {
    const widget = '<script>(function(){ var f = document.getElementById("in-page-form"); var s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.3.2/iframeResizer.min.js"; document.body.appendChild(s); })();</script>';
    expect(audit({ settings: { scripts_body_end: widget } as never })).toEqual([]);
  });

  it('flags tracking code outside the consent gate, and accepts it in scripts_optional with the banner on', () => {
    const gtag = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script><script>gtag("config","G-ABC123")</script>';
    const pixel = '<script>!function(f){f.fbq=function(){}}(window);fbq("init","123")</script>';
    expect(audit({ settings: { scripts_head: gtag } as never })).toEqual([
      { id: 'tracking_outside_consent', location: 'settings.scripts_head', match: 'Google Analytics / Tag Manager' },
    ]);
    expect(audit({ sources: [{ location: 'partial:header', html: pixel }] })).toEqual([
      { id: 'tracking_outside_consent', location: 'partial:header', match: 'Meta Pixel' },
    ]);
    expect(audit({ settings: { cookie_consent: { enabled: true, scripts_necessary: gtag } } as never })).toHaveLength(1);
    expect(audit({ settings: { cookie_consent: { enabled: true, scripts_optional: gtag } } as never })).toEqual([]);
    // Without the banner, scripts_optional is not a consent gate.
    expect(audit({ settings: { cookie_consent: { enabled: false, scripts_optional: gtag } } as never })).toHaveLength(1);
  });

  it('requires the cookie banner for analytics and advertising integrations', () => {
    const apps = { apps: { integrations: { enabled: true, config: { google_analytics__measurement_id: 'G-7CSQN7HMGM', google_places__browser_key: 'AIzaSyA5VIsDo6EJD1_nM626lZKWkjeAxnKj2Oc' } } } };
    expect(audit({ apps })).toEqual([{ id: 'tracking_without_consent_banner', location: 'apps.integrations', match: 'Google Analytics 4' }]);
    expect(audit({ apps, settings: { cookie_consent: { enabled: true } } as never })).toEqual([]);
    expect(audit({ apps: { apps: { integrations: { ...apps.apps.integrations, enabled: false } } } })).toEqual([]);
  });

  it('turns findings into one launch issue per kind, naming the places', () => {
    const issues = scriptAuditIssues(audit({
      settings: { scripts_head: '<script src="/wp-includes/js/jquery/jquery.min.js"></script><script src="https://connect.facebook.net/en_US/fbevents.js"></script>' } as never,
    }));
    expect(issues.map(issue => issue.id)).toEqual(['source_runtime_script', 'tracking_outside_consent']);
    expect(issues[0].detail).toContain('settings.scripts_head (/wp-includes/)');
    expect(issues[1].detail).toContain('Integrations app');
  });
});
