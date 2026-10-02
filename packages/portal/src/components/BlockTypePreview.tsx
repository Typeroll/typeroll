// Preview tab of the block type builder. The definition (saved or not) is
// rendered by the server's preview endpoint, through the shared renderer and
// sanitizer, beside the Site's other block types. Sample data starts from
// the schema and is edited with the same field widgets as the page editor.

import { useEffect, useMemo, useRef, useState } from 'react';
import { sampleBlockData, type BlockTypeProblem, type FieldDefinition } from '@typeroll/shared';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import FieldInput from './FieldInput';

type Width = 'mobile' | 'tablet' | 'desktop';
const WIDTHS: Record<Width, { px: number; label: string; icon: typeof Monitor }> = {
  mobile: { px: 390, label: 'Mobile', icon: Smartphone },
  tablet: { px: 768, label: 'Tablet', icon: Tablet },
  desktop: { px: 1280, label: 'Desktop', icon: Monitor },
};

export interface PreviewResult { ok?: boolean; html: string; css: string; document?: string; problems: BlockTypeProblem[] }

/**
 * The iframe document for a preview result: the server's standalone
 * `document` (site theme and CSS) when there is one, otherwise the fragment
 * in a plain shell.
 */
export function previewDocument(result: { html: string; css: string; document?: string }): string {
  if (result.document) return result.document;
  if (/^\s*(<!doctype|<html)/i.test(result.html)) return result.html;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{--color-primary:#4f46e5;--color-primary-fg:#fff;--color-text:#0f172a;--color-text-light:#475569;--color-bg:#fff}
html,body{margin:0;background:#fff;color:#0f172a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
body{padding:1.25rem}img{max-width:100%;height:auto}a{color:#3730a3}
${result.css.replace(/<\/style/gi, '<\\/style')}</style></head><body>${result.html}</body></html>`;
}

/** Keep sample values for fields that still exist with the same type; new fields get samples. */
function mergeSample(schema: FieldDefinition[], previous: Record<string, unknown>, previousSchema: FieldDefinition[]): Record<string, unknown> {
  const fresh = sampleBlockData(schema);
  const out: Record<string, unknown> = {};
  for (const field of schema) {
    const before = previousSchema.find(candidate => candidate.name === field.name);
    out[field.name] = before && before.type === field.type && field.name in previous ? previous[field.name] : fresh[field.name];
  }
  return out;
}

export default function BlockTypePreview({ siteId, definition, schema, renderVersion }: {
  siteId: string;
  /** The definition as the API takes it. */
  definition: Record<string, unknown>;
  schema: FieldDefinition[];
  renderVersion?: number;
}) {
  const [width, setWidth] = useState<Width>('desktop');
  const [data, setData] = useState<Record<string, unknown>>(() => sampleBlockData(schema));
  const lastSchema = useRef(schema);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState(320);
  const [available, setAvailable] = useState(800);
  const frameBox = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);

  const schemaKey = JSON.stringify(schema);
  useEffect(() => {
    setData(current => mergeSample(schema, current, lastSchema.current));
    lastSchema.current = schema;
  }, [schemaKey]);

  const requestKey = JSON.stringify({ definition, data, renderVersion });
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/blocks/types/preview`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ definition, data, ...(renderVersion ? { render_version: renderVersion } : {}) }),
        });
        const body = await res.json().catch(() => ({})) as Partial<PreviewResult> & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `Preview failed (${res.status})`);
        setResult({ ok: body.ok, html: body.html ?? '', css: body.css ?? '', document: body.document, problems: body.problems ?? [] });
        setError(null);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [siteId, requestKey]);

  useEffect(() => {
    const el = frameBox.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setAvailable(Math.max(1, el.clientWidth - 24)));
    observer.observe(el);
    setAvailable(Math.max(1, el.clientWidth - 24));
    return () => observer.disconnect();
  }, []);

  const doc = useMemo(() => result ? previewDocument(result) : '', [result]);
  const px = WIDTHS[width].px;
  const scale = Math.min(1, available / px);
  const errors = (result?.problems ?? []).filter(problem => problem.severity === 'error');

  return (
    <div className="bb-preview">
      <div style={{ minWidth: 0 }}>
        <div className="bb-widths" role="group" aria-label="Preview width">
          {(Object.keys(WIDTHS) as Width[]).map(key => {
            const Icon = WIDTHS[key].icon;
            return <button key={key} type="button" aria-pressed={width === key} onClick={() => setWidth(key)}>
              <Icon size={14} aria-hidden="true" /> {WIDTHS[key].label} <span className="bb-help" style={{ fontSize: '.72rem' }}>{WIDTHS[key].px}px</span>
            </button>;
          })}
        </div>
        {error && <p role="alert" className="bb-status bb-status--error">{error}</p>}
        {errors.length > 0 && <p className="bb-status bb-status--error">The definition has {errors.length} {errors.length === 1 ? 'error' : 'errors'}. Fix {errors.length === 1 ? 'it' : 'them'} to see the preview.</p>}
        <div ref={frameBox} className="bb-frame" style={{ height: frameHeight * scale + 24 }}>
          <div className="bb-frame__scaler" style={{ width: px, transform: scale < 1 ? `scale(${scale})` : undefined }}>
            <iframe
              ref={iframe}
              title="Block type preview"
              srcDoc={doc}
              // No scripts run in the preview; same origin only lets the editor measure its height.
              sandbox="allow-same-origin"
              style={{ width: px, height: frameHeight }}
              onLoad={() => {
                const height = iframe.current?.contentDocument?.documentElement.scrollHeight;
                if (height) setFrameHeight(Math.max(200, Math.min(height + 4, 4000)));
              }}
            />
          </div>
        </div>
      </div>
      <section className="bb-sample" aria-label="Sample content">
        <h3>Sample content</h3>
        <p className="bb-help" style={{ margin: '0 0 .75rem' }}>Only for this preview; nothing here is saved. Fill it in as an editor would on a page.</p>
        {schema.length === 0 && <p className="bb-help">This block type has no fields.</p>}
        {schema.map(field => (
          <FieldInput key={field.name} siteId={siteId} field={field} value={data[field.name]}
            onChange={value => setData(current => ({ ...current, [field.name]: value }))} />
        ))}
        <button type="button" className="bb-btn bb-btn--small" onClick={() => setData(sampleBlockData(schema))}>Reset sample content</button>
      </section>
    </div>
  );
}
