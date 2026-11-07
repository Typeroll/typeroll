// The font roles and font services in the site settings' Typography card.
// Lives inside the settings form: every role and the service list write
// hidden inputs (fonts.heading … fonts.services) that the form saves.

import { useEffect, useId, useRef, useState } from 'react';
import { FONT_PLAN_RENDER_VERSION, type FontService, type SiteSettings } from '@typeroll/shared';
import FontPicker from './FontPicker';
import { PROVIDER_LABEL, ROLE_LABEL, addService, parseServiceInput, rolesUsingFamilies, serializeServices, serviceKey, serviceLabel, type SiteFonts } from './font-picker-model';
import { useSiteFontFiles } from './font-preview';

interface Props {
  siteId: string;
  fonts: SiteSettings['fonts'];
  /** The site's language, for sample text. */
  language?: string;
  renderVersion: number;
  disabled?: boolean;
}

type RoleKey = 'heading' | 'body' | 'display' | 'accent' | 'mono';

const ROLE_HELP: Record<RoleKey, string> = {
  heading: 'Headings on every page.',
  body: 'Body text, buttons and forms.',
  display: 'Large headings and heroes that choose the display font.',
  accent: 'Eyebrows, quotes and other text that chooses the accent font.',
  mono: 'Code and other text that chooses the monospace font.',
};

export default function SiteFontSettings({ siteId, fonts, language, renderVersion, disabled = false }: Props) {
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const uploads = useSiteFontFiles(siteId);
  const [roles, setRoles] = useState<Record<RoleKey, string>>({
    heading: fonts.heading ?? '', body: fonts.body ?? '', display: fonts.display ?? '', accent: fonts.accent ?? '', mono: fonts.mono ?? '',
  });
  const [services, setServices] = useState<FontService[]>(fonts.services ?? []);
  const [serviceInput, setServiceInput] = useState('');
  const [serviceError, setServiceError] = useState('');
  const [serviceNotice, setServiceNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const servicesInput = useRef<HTMLInputElement>(null);
  const firstServices = useRef(true);
  const before15 = renderVersion < FONT_PLAN_RENDER_VERSION;
  const siteFonts: SiteFonts = { ...roles, services };
  for (const key of Object.keys(roles) as RoleKey[]) if (!roles[key]) delete siteFonts[key];

  useEffect(() => {
    if (firstServices.current) { firstServices.current = false; return; }
    servicesInput.current?.dispatchEvent(new Event('input', { bubbles: true }));
  }, [services]);

  async function add() {
    setServiceError('');
    setServiceNotice('');
    const parsed = parseServiceInput(serviceInput);
    if ('error' in parsed) { setServiceError(parsed.error); return; }
    setAdding(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/fonts/services/inspect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify(parsed.request),
      });
      const body = await response.json().catch(() => ({})) as { families?: string[]; error?: string };
      if (!response.ok) { setServiceError(body.error ?? `Could not read the stylesheet (${response.status}).`); return; }
      const families = Array.isArray(body.families) ? body.families : [];
      if (!families.length) { setServiceError('The stylesheet defines no font families. Check that the web project or stylesheet has fonts.'); return; }
      const service: FontService = parsed.request.provider === 'adobe'
        ? { provider: 'adobe', kit: parsed.request.kit, families }
        : { provider: parsed.request.provider, url: parsed.request.url, families };
      const result = addService(services, service);
      if ('error' in result) { setServiceError(result.error); return; }
      setServices(result.services);
      setServiceInput('');
      setServiceNotice(`Added ${families.length === 1 ? families[0] : `${families.length} families`} from ${PROVIDER_LABEL[service.provider]}. Choose them for a role above.`);
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : 'Could not read the stylesheet.');
    } finally {
      setAdding(false);
    }
  }

  function remove(service: FontService) {
    setServices(services.filter(existing => serviceKey(existing) !== serviceKey(service)));
    const affected = rolesUsingFamilies(siteFonts, service.families);
    setServiceError('');
    setServiceNotice(affected.length
      ? `Removed. ${affected.map(role => ROLE_LABEL[role]).join(', ')} still ${affected.length === 1 ? 'uses' : 'use'} a family from it; choose another font there, or it loads from Google Fonts by name.`
      : 'Removed.');
  }

  const picker = (role: RoleKey, emptyLabel?: string) => (
    <FontPicker
      key={role} siteId={siteId} role={role} label={`${ROLE_LABEL[role]} font`} name={`fonts.${role}`} value={roles[role]}
      onChange={family => setRoles(previous => ({ ...previous, [role]: family }))} emptyLabel={emptyLabel}
      fonts={siteFonts} language={language} uploads={uploads} services={services} renderVersion={renderVersion} disabled={disabled} help={ROLE_HELP[role]}
    />
  );

  return (
    <div className="stack site-font-settings">
      <p className="muted text-sm" style={{ margin: 0 }}>
        Choose a family for each role. Styles and blocks choose a role, never a family, so changing a font here changes it everywhere.
        Pick from the catalog of open-licence families, your own uploaded fonts in the <a href={`/app/sites/${encodeURIComponent(siteId)}/fonts`}>Fonts library</a>,
        a font service below, the system font, or any Google Fonts family by name.
      </p>
      {picker('heading')}
      {picker('body')}
      {before15 && (
        <p className="muted text-sm" role="note">
          Display and accent take effect from render version {FONT_PLAN_RENDER_VERSION}. This site uses render version {renderVersion}, so until you
          upgrade under Rendering they use the heading and body fonts.
        </p>
      )}
      {picker('display', 'Same as heading')}
      {picker('accent', 'Same as body')}
      {picker('mono', 'System monospace')}

      <fieldset className="site-font-services" aria-describedby={`${domId}-services-privacy`}>
        <legend>Font services</legend>
        <p className="muted text-sm" style={{ margin: 0 }}>
          Enter an Adobe Fonts web project ID, or paste a Bunny Fonts or Fontshare stylesheet URL. Its families then appear in the font lists above.
        </p>
        <div className="field">
          <label htmlFor={`${domId}-service`}>Web project ID or stylesheet URL</label>
          <div className="site-font-services__row">
            <input id={`${domId}-service`} value={serviceInput} disabled={disabled || adding} placeholder="abc1def or https://fonts.bunny.net/css?family=inter:400,700"
              aria-invalid={!!serviceError || undefined} aria-describedby={serviceError ? `${domId}-service-error` : undefined}
              onChange={event => setServiceInput(event.target.value)} onInput={event => event.stopPropagation()}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }} />
            <button type="button" className="btn btn--secondary" disabled={disabled || adding || !serviceInput.trim()} onClick={() => void add()}>{adding ? 'Reading…' : 'Add'}</button>
          </div>
        </div>
        {serviceError && <p id={`${domId}-service-error`} role="alert" className="site-font-services__error">{serviceError}</p>}
        {serviceNotice && <p role="status" className="muted text-sm" style={{ margin: 0 }}>{serviceNotice}</p>}
        {services.length > 0 && (
          <ul className="site-font-services__list">
            {services.map(service => (
              <li key={serviceKey(service)}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{serviceLabel(service)}</strong>
                  <div className="muted text-sm">{service.families.join(', ')}</div>
                </div>
                {!disabled && <button type="button" className="btn btn--ghost btn--sm" aria-label={`Remove ${serviceLabel(service)}`} onClick={() => remove(service)}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        <p id={`${domId}-services-privacy`} className="muted text-sm" style={{ margin: 0 }}>
          Privacy: these fonts load from the provider’s CDN on the published site, like the Google Fonts CDN delivery below, so each visitor’s
          browser contacts the provider. Adobe’s licence does not allow self-hosting its fonts. Adobe Fonts previews here only when this
          portal’s address is one of the web project’s domains.
        </p>
        <input ref={servicesInput} type="hidden" name="fonts.services" value={serializeServices(services)} />
      </fieldset>
      <style dangerouslySetInnerHTML={{ __html: SERVICES_CSS }} />
    </div>
  );
}

const SERVICES_CSS = `
        .site-font-services { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: .75rem 1rem 1rem; display: grid; gap: .6rem; min-width: 0; }
        .site-font-services legend { font-weight: 600; padding: 0 .25rem; }
        .site-font-services__row { display: flex; gap: .5rem; flex-wrap: wrap; }
        .site-font-services__row input { flex: 1 1 16rem; min-width: 0; }
        .site-font-services__list { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
        .site-font-services__list li { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; padding: .5rem .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
        .site-font-services__error { color: var(--color-danger); margin: 0; font-size: .875rem; }
      `;
