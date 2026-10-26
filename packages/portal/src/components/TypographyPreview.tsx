import { useEffect, useRef, useState } from 'react';
import { siteThemeCss, siteStylesCss, contentWellCss, resolveRenderVersion, resolveBreakpointWidths, typographyError, designScalesError, type SiteSettings } from '@typeroll/shared';

/** No scripts, same-origin privileges, customer HTML or network resources. */
export function typographyPreviewDocument(settings: SiteSettings): string {
  const theme = contentWellCss(resolveRenderVersion(settings.render_version)) + siteThemeCss(settings) + siteStylesCss(settings.styles, { colors: settings.colors, breakpoints: resolveBreakpointWidths(settings.responsive_breakpoints), renderVersion: settings.render_version });
  // A site style may contain advanced CSS. Keep it inside the sandbox's style node.
  const css = theme.replace(/</g, '\\3c ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}
html{font-size:var(--font-size-base)}body{margin:0;font-family:var(--font-body),sans-serif;color:var(--color-text);background:var(--color-background)}main{padding:var(--space-lg)}p{font-size:var(--body-size,1rem);line-height:var(--body-leading,1.65);max-width:var(--measure-prose)}section{padding:var(--space-xl) var(--space-md);background:var(--color-surface)}h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),serif;margin:0}h1{font-size:var(--h1-size,var(--type-h1));line-height:var(--h1-leading)}h2{font-size:var(--h2-size,var(--type-h2));line-height:var(--h2-leading)}h3{font-size:var(--h3-size,var(--type-h3));line-height:var(--h3-leading)}h4{font-size:var(--h4-size,var(--type-h4));line-height:var(--h4-leading)}h5{font-size:var(--h5-size,var(--type-h5));line-height:var(--h5-leading)}h6{font-size:var(--h6-size,var(--type-h6));line-height:var(--h6-leading)}</style></head><body><main class="page-content"><h1>A clear beginning</h1><p>Good typography gives each page a comfortable rhythm. Headings guide the reader and the text has room to breathe.</p><h2>The next idea</h2><p>Adjust the site controls to compare the same scale at phone, tablet and desktop widths.</p><h3>Details that matter</h3><p>Content remains readable as the space changes.</p><h4>A smaller heading</h4><h5>A supporting detail</h5><h6>A short label</h6><section><div class="block-section-inner"><div data-block="heading"><h2>A boxed heading</h2></div><p>The section provides its own padding. Its opening heading adds no top margin.</p></div></section></main></body></html>`;
}
function PreviewFrame({ width, document }: { width: number; document: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => setScale(Math.min(1, entry.contentRect.width / width)));
    resize.observe(element);
    return () => resize.disconnect();
  }, [width]);
  return <div ref={frame} style={{width:'100%',maxWidth:width,height:1000*scale,overflow:'hidden'}}>
    <iframe title={`Typography at ${width}px`} sandbox="" srcDoc={document} style={{width,height:1000,border:'1px solid #ddd',boxSizing:'border-box',display:'block',transform:`scale(${scale})`,transformOrigin:'top left'}} />
  </div>;
}
export default function TypographyPreview({ settings }: { settings: SiteSettings }) {
  const root = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(settings);
  const [error, setError] = useState('');
  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return;
    const update = () => {
      const data = new FormData(form), next = structuredClone(settings);
      next.typography = {};
      next.design_scales = {};
      try {
        for (const [name,value] of data) {
          if (typeof value !== 'string') continue;
          if (name.startsWith('typography.')) (next.typography as Record<string,number>)[name.split('.')[1]] = Number(value);
          if (name === 'fonts.size_base') next.fonts.size_base = Number(value);
          if (name === 'fonts.heading' || name === 'fonts.body') next.fonts[name.split('.')[1] as 'heading'|'body'] = value;
          if (name.startsWith('design_scales.') && value.trim()) {
            const [,scale,step] = name.split('.');
            ((next.design_scales as any)[scale] ??= {})[step] = value.trim().startsWith('{') ? JSON.parse(value) : value;
          }
        }
        const validation = typographyError(next.typography) ?? designScalesError(next.design_scales);
        if (validation) { setError(validation); return; }
        if (!Number.isFinite(next.fonts.size_base) || next.fonts.size_base < 12 || next.fonts.size_base > 24) { setError('Base font size must be from 12 to 24px.'); return; }
        setError(''); setCurrent(next);
      } catch { setError('Enter valid JSON for responsive scale maps.'); }
    };
    form.addEventListener('input', update);
    return () => form.removeEventListener('input', update);
  }, [settings]);
  return <div ref={root}>
    <h3>Typography at three widths</h3>
    <p>Live preview of unsaved controls and your saved role styles. Custom font downloads are disabled here; verify your chosen webfonts on a site preview. Fixed role sizes override the scale. Previews scale to fit this panel; their layout uses the labeled viewport width.</p>
    {resolveRenderVersion(settings.render_version) < 10 && <p>Fluid defaults require render version 10. Upgrade in Rendering after checking your site preview.</p>}
    {error && <p role="alert">{error}</p>}
    {[375,768,1280].map(width => <details key={width} open={width === 375}>
      <summary>{width === 375 ? 'Phone' : width === 768 ? 'Tablet' : 'Desktop'} — {width}px</summary>
      <PreviewFrame width={width} document={typographyPreviewDocument(current)} />
    </details>)}
  </div>;
}
