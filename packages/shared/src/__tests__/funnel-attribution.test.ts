// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.autopilot.se/"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFunnelAttributionRuntime,
  validateFunnelAttributionConfig,
} from '../funnel-attribution';
import type { FunnelAttributionConfig } from '../types';

declare global {
  interface Window {
    TyperollFunnels?: { init: (root?: ParentNode) => void };
    gtag?: (...args: unknown[]) => void;
  }
}

const config: FunnelAttributionConfig = {
  funnels: [{
    id: 'ai-planen',
    page_paths: ['/ai-planen/'],
    source: 'current_url',
    parameters: [
      { from: 'utm_source' },
      { from: 'utm_medium' },
      { from: 'utm_campaign' },
      { from: 'utm_content' },
      { from: 'utm_term' },
    ],
    targets: [{
      type: 'link',
      host: 'calendly.com',
      path: '/thomaswisten/ai-planen-utforskande-samtal',
      click_event: 'calendly_click',
      destination: 'calendly',
    }],
  }],
};

function run(
  value: FunnelAttributionConfig,
  analyticsRequiresConsent = false,
  firstPartyAnalytics?: { endpoint: string; token: string },
): void {
  (0, eval)(buildFunnelAttributionRuntime(value, analyticsRequiresConsent, firstPartyAnalytics));
}

function attributionCookie(name: string): { values: Record<string, string> } {
  const raw = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))!.slice(name.length + 1);
  return JSON.parse(decodeURIComponent(raw)) as { values: Record<string, string> };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.cookie = 'tr_consent=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; Secure';
  document.cookie = 'tr_attr_first_v1=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; Secure';
  document.cookie = 'tr_attr_last_v1=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; Secure';
  delete window.TyperollFunnels;
  Reflect.deleteProperty(window, 'typerollConsent');
  delete window.gtag;
  vi.restoreAllMocks();
});

describe('funnel attribution config validation', () => {
  it('accepts the Autopilot one-page rule', () => {
    expect(validateFunnelAttributionConfig(config)).toEqual([]);
  });

  it('rejects personal data, unsafe protocols and malformed targets by default', () => {
    const bad = structuredClone(config) as FunnelAttributionConfig;
    bad.funnels[0].parameters = [{ from: 'customer_email' }];
    bad.funnels[0].targets[0].protocol = 'https:';
    (bad.funnels[0].targets[0] as { protocol: string }).protocol = 'javascript:';
    const errors = validateFunnelAttributionConfig(bad).join(' ');
    expect(errors).toContain('personal data');
    expect(errors).toContain('protocol must be https:');
  });

  it('rejects synthetic fallback attribution without explicit acknowledgement', () => {
    const synthetic = structuredClone(config) as FunnelAttributionConfig;
    synthetic.funnels[0].parameters[0].fallback = 'website';
    expect(validateFunnelAttributionConfig(synthetic).join(' ')).toContain(
      'fallback requires allow_synthetic_fallbacks=true',
    );

    synthetic.allow_synthetic_fallbacks = true;
    expect(validateFunnelAttributionConfig(synthetic)).toEqual([]);
  });
});

describe('funnel attribution browser runtime', () => {
  it('forwards only allowlisted values, preserves target state and emits one non-blocking event', () => {
    history.replaceState({}, '', '/ai-planen/?utm_source=facebook&utm_medium=paid_social&utm_content=V%C3%A5r+annons&ignored=secret');
    document.body.innerHTML = '<a id="cta" href="https://calendly.com/thomaswisten/ai-planen-utforskande-samtal?month=2026-08#booking">Boka samtal</a>';
    const gtag = vi.fn();
    window.gtag = gtag;

    run(config);
    window.TyperollFunnels?.init(document);

    const link = document.querySelector<HTMLAnchorElement>('#cta')!;
    const target = new URL(link.href);
    expect(target.searchParams.getAll('utm_source')).toEqual(['facebook']);
    expect(target.searchParams.get('utm_medium')).toBe('paid_social');
    expect(target.searchParams.get('utm_content')).toBe('Vår annons');
    expect(target.searchParams.has('utm_campaign')).toBe(false);
    expect(target.searchParams.has('ignored')).toBe(false);
    expect(target.searchParams.get('month')).toBe('2026-08');
    expect(target.hash).toBe('#booking');

    link.click();
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith('event', 'calendly_click', expect.objectContaining({
      link_text: 'Boka samtal',
      funnel_id: 'ai-planen',
      destination: 'calendly',
    }));
  });

  it('reuses consented Autopilot last-touch values without inventing missing UTMs', () => {
    const persistent = structuredClone(config) as FunnelAttributionConfig;
    persistent.funnels[0].source = 'current_or_stored';
    persistent.funnels[0].storage = {
      enabled: true,
      ttl_days: 30,
      touch: 'both',
      read_touch: 'last_touch',
      consent: 'optional',
    };
    document.cookie = 'tr_consent=all; path=/; SameSite=Lax; Secure';
    history.replaceState({}, '', '/ai-planen/?utm_source=facebook&utm_medium=paid_social&utm_campaign=real-campaign');
    document.body.innerHTML = '<a id="first" href="https://calendly.com/thomaswisten/ai-planen-utforskande-samtal">Book</a>';

    run(persistent);
    expect(new URL(document.querySelector<HTMLAnchorElement>('#first')!.href).searchParams.get('utm_campaign'))
      .toBe('real-campaign');

    history.replaceState({}, '', '/ai-planen/');
    document.body.innerHTML = '<a id="return" href="https://calendly.com/thomaswisten/ai-planen-utforskande-samtal">Book</a>';
    window.TyperollFunnels?.init(document);
    const returned = new URL(document.querySelector<HTMLAnchorElement>('#return')!.href);
    expect(returned.searchParams.get('utm_source')).toBe('facebook');
    expect(returned.searchParams.get('utm_medium')).toBe('paid_social');
    expect(returned.searchParams.get('utm_campaign')).toBe('real-campaign');
    expect(returned.searchParams.has('utm_content')).toBe(false);
    expect(returned.searchParams.has('utm_term')).toBe(false);
  });

  it('does not write attribution cookies before optional consent', () => {
    history.replaceState({}, '', '/stored/?utm_source=facebook');
    const stored: FunnelAttributionConfig = {
      funnels: [{
        id: 'stored', page_paths: ['/stored/'], source: 'current_or_stored',
        parameters: [{ from: 'utm_source' }],
        targets: [{ type: 'link', host: 'example.com', path: '/book' }],
        storage: { enabled: true, touch: 'both', consent: 'optional', ttl_days: 30 },
      }],
    };
    document.body.innerHTML = '<a href="https://example.com/book">Book</a>';

    run(stored);
    expect(document.cookie).not.toContain('tr_attr_first_v1=');
    expect(document.cookie).not.toContain('tr_attr_last_v1=');

    document.cookie = 'tr_consent=all; path=/; SameSite=Lax; Secure';
    document.dispatchEvent(new CustomEvent('typeroll:consent', { detail: { choice: 'all' } }));
    expect(document.cookie).toContain('tr_attr_first_v1=');
    expect(document.cookie).toContain('tr_attr_last_v1=');

    document.cookie = 'tr_consent=rejected; path=/; SameSite=Lax; Secure';
    document.dispatchEvent(new CustomEvent('typeroll:consent', { detail: { choice: 'rejected' } }));
    expect(document.cookie).not.toContain('tr_attr_first_v1=');
    expect(document.cookie).not.toContain('tr_attr_last_v1=');
  });

  it('emits analytics only after optional consent when the site uses the consent banner', () => {
    history.replaceState({}, '', '/ai-planen/?utm_source=facebook');
    document.body.innerHTML = '<a id="cta" href="https://calendly.com/thomaswisten/ai-planen-utforskande-samtal">Book</a>';
    const gtag = vi.fn();
    window.gtag = gtag;

    run(config, true);
    document.querySelector<HTMLAnchorElement>('#cta')!.click();
    expect(gtag).not.toHaveBeenCalled();

    document.cookie = 'tr_consent=all; path=/; SameSite=Lax; Secure';
    document.querySelector<HTMLAnchorElement>('#cta')!.click();
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it('sends a consented first-party event with only resolved allowlisted attribution', async () => {
    history.replaceState({}, '', '/ai-planen/?utm_source=facebook&utm_campaign=launch&email=secret@example.com');
    document.body.innerHTML = '<a id="cta" href="https://calendly.com/thomaswisten/ai-planen-utforskande-samtal">Book</a>';
    document.cookie = 'tr_consent=all; path=/; SameSite=Lax; Secure';
    const sendBeacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);

    run(config, true, {
      endpoint: 'https://forms.typeroll.com/api/analytics/events',
      token: 'signed-site-token',
    });
    document.querySelector<HTMLAnchorElement>('#cta')!.click();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0][0]).toBe('https://forms.typeroll.com/api/analytics/events');
    const payload = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text());
    expect(payload).toEqual({
      token: 'signed-site-token',
      event: {
        name: 'calendly_click',
        funnel_id: 'ai-planen',
        destination: 'calendly',
        path: '/ai-planen/',
        attribution: { utm_source: 'facebook', utm_campaign: 'launch' },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('secret@example.com');
  });

  it('preserves first touch and replaces the complete last-touch snapshot', () => {
    const stored: FunnelAttributionConfig = {
      funnels: [{
        id: 'stored', page_paths: ['/stored/'], source: 'current_or_stored',
        parameters: [{ from: 'utm_source' }, { from: 'utm_campaign' }],
        targets: [{ type: 'link', host: 'example.com', path: '/book' }],
        storage: { enabled: true, touch: 'both', consent: 'optional' },
      }],
    };
    document.cookie = 'tr_consent=all; path=/; SameSite=Lax; Secure';
    history.replaceState({}, '', '/stored/?utm_source=facebook&utm_campaign=launch');
    document.body.innerHTML = '<a href="https://example.com/book">Book</a>';
    run(stored);

    history.replaceState({}, '', '/stored/?utm_source=google');
    window.TyperollFunnels?.init(document);

    expect(attributionCookie('tr_attr_first_v1').values).toEqual({
      utm_source: 'facebook',
      utm_campaign: 'launch',
    });
    expect(attributionCookie('tr_attr_last_v1').values).toEqual({ utm_source: 'google' });
  });
});
