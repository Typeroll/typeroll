import { useEffect, useState } from 'react';
import {
  ON_COLOR_TEXT,
  ON_COLOR_TOKENS,
  formatContrast,
  isOnColorValue,
  onColor,
  onColorBase,
  textContrast,
  type OnColorToken,
  type SiteColors,
} from '@typeroll/shared';

interface Props {
  colors: SiteColors;
  /** The site's render version: it decides the automatic choice. */
  renderVersion: number;
}

const LABELS: Record<OnColorToken, string> = { on_primary: 'Text on primary', on_secondary: 'Text on secondary', on_accent: 'Text on accent' };

/**
 * The text colour on primary, secondary and accent, inside the Settings
 * form. Automatic picks black or white; a chosen colour applies on every
 * render version. Each field shows both contrast measures live, as the
 * palette colours above it change.
 */
export default function OnColorFields({ colors, renderVersion }: Props) {
  const [palette, setPalette] = useState<SiteColors>(colors);
  const [chosen, setChosen] = useState<Partial<Record<OnColorToken, boolean>>>(
    Object.fromEntries(ON_COLOR_TOKENS.map(token => [token, isOnColorValue(colors[token])])),
  );
  const [values, setValues] = useState<Partial<Record<OnColorToken, string>>>(
    Object.fromEntries(ON_COLOR_TOKENS.map(token => [token, isOnColorValue(colors[token]) ? colors[token] : onColor(colors[onColorBase(token)], renderVersion)])),
  );

  // Follow the palette pickers rendered by the form around this island.
  useEffect(() => {
    const form = document.querySelector<HTMLInputElement>('input[name="colors.primary"]')?.form;
    if (!form) return;
    const update = (event: Event) => {
      const input = event.target as HTMLInputElement;
      const match = input.name?.match(/^colors\.(primary|secondary|accent)$/);
      if (match) setPalette(current => ({ ...current, [match[1]]: input.value }));
    };
    form.addEventListener('input', update);
    return () => form.removeEventListener('input', update);
  }, []);

  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      <p className="muted text-sm" style={{ margin: 0 }}>
        Text on buttons, badges, tabs and call-to-action sections in each theme colour. Automatic picks black or white,
        whichever reads better{renderVersion >= 8 ? ' (by APCA)' : ' (by the WCAG 2 ratio; render version 8 uses APCA)'}.
        A chosen colour applies on every render version. Button text (16px, semibold) needs APCA Lc 60; body text Lc 75.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {ON_COLOR_TOKENS.map(token => {
          const base = onColorBase(token);
          const automatic = onColor(palette[base], renderVersion);
          const text = chosen[token] ? values[token] : automatic;
          const measured = textContrast(text, palette[base], ON_COLOR_TEXT);
          const id = `colors-${token}`;
          return (
            <div className="field" key={token}>
              <label htmlFor={`${id}-mode`}>{LABELS[token]}</label>
              <select id={`${id}-mode`} name={`colors.${token}.mode`} value={chosen[token] ? 'custom' : 'auto'}
                onChange={event => setChosen(current => ({ ...current, [token]: event.target.value === 'custom' }))}>
                <option value="auto">Automatic ({automatic})</option>
                <option value="custom">Choose a colour</option>
              </select>
              {chosen[token] && (
                <input id={id} aria-label={`${LABELS[token]} colour`} name={`colors.${token}`} type="color" value={values[token]}
                  onChange={event => setValues(current => ({ ...current, [token]: event.target.value }))}
                  style={{ height: '40px', padding: '0.25rem' }} />
              )}
              {measured && (
                <p className="text-sm" style={{ margin: 0 }}>
                  <span aria-hidden="true" style={{ display: 'inline-block', padding: '0.125rem 0.5rem', borderRadius: '0.25rem', fontWeight: 600, background: palette[base], color: text, marginRight: '0.5rem' }}>Aa</span>
                  {formatContrast(measured)}.{' '}
                  {measured.apca_pass
                    ? <span>Readable as button text.</span>
                    : <strong>Below Lc 60: hard to read as button text.</strong>}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
