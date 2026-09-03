import { useEffect, useMemo, useRef, useState } from 'react';
import type { Page, WorkingCopy } from '@typeroll/shared';
import { Monitor, Tablet, Smartphone, ExternalLink, Copy, Check } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { html as htmlLang } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';
import HistoryPanel from './HistoryPanel';
import SerpPreview from './SerpPreview';
import OgPreview from './OgPreview';
import { DocStatus } from './EditorStatus';
import PublishMenu, { PAGE_STATUS_OPTIONS } from './PublishMenu';
import ChatInterface from './ChatInterface';
import ContentModeSwitcher from './ContentModeSwitcher';
import TemplatePicker from './TemplatePicker';

// Inline parser — keeps this file client-bundleable (the server-side
// partials-usage module imports vstore, which can't run in the browser).
function listBlocksUsedInHtml(html: string): string[] {
  if (!html || !html.includes('<x-include')) return [];
  const re = /<x-include\s+name=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/x-include>)/gi;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = (m[1] ?? m[2] ?? '').trim();
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

interface Props {
  siteId: string;
  page: Page;
  /** Unsaved autosaved edits, loaded server-side. Overlaid on `page` at mount. */
  workingCopy?: WorkingCopy | null;
  previewUrl: string;
  /** Permalink on the deployed site (null when the site has no live base). */
  liveUrl?: string | null;
  /** ISO timestamp of this version's last successful deploy (null if never). */
  lastDeployedAt: string | null;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Device = 'desktop' | 'tablet' | 'mobile';

export default function HtmlPageEditor({ siteId, page, workingCopy, previewUrl, liveUrl, lastDeployedAt }: Props) {
  // Edits autosave to a server-side working copy; the canonical page only
  // changes on the deliberate Save (or a status change) in the Publish menu.
  const [draft, setDraft] = useState<Page>({ ...page, ...(workingCopy?.fields ?? {}) } as Page);
  const [hasWc, setHasWc] = useState<boolean>(!!workingCopy);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'content' | 'ai' | 'blocks' | 'seo' | 'settings' | 'history'>('content');
  const [device, setDevice] = useState<Device>('desktop');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canvasId = useMemo(
    () => `html-${siteId}-${page.id}-editorbridge`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128),
    [siteId, page.id],
  );
  const canvasScrollRef = useRef(0);
  const restoreCanvasScrollRef = useRef<number | null>(null);
  const postCanvas = (command: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage({
    channel: 'typeroll.editor-canvas', version: 1, canvas_id: canvasId, ...command,
  }, '*');
  function reloadPreview(): void {
    const ifr = iframeRef.current;
    if (!ifr) return;
    restoreCanvasScrollRef.current = canvasScrollRef.current;
    ifr.src = ifr.src;
  }
  const [copied, setCopied] = useState(false);
  const [seoWarnings, setSeoWarnings] = useState<string[]>([]);

  // The previewUrl passed in is a portal-relative path. For sharing, give
  // the user the absolute URL using the portal's own origin — resolved after
  // mount, since it's rendered as text and reading it during the first render
  // would make the server and client markup disagree.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.channel !== 'typeroll.editor-canvas' || data.version !== 1 || data.canvas_id !== canvasId) return;
      if (data.type === 'scroll' && typeof data.scroll_y === 'number' && Number.isFinite(data.scroll_y)) canvasScrollRef.current = data.scroll_y;
      if (data.type === 'ready' && restoreCanvasScrollRef.current !== null) {
        postCanvas({ action: 'scroll', scroll_y: restoreCanvasScrollRef.current });
        restoreCanvasScrollRef.current = null;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [canvasId]);
  const absolutePreviewUrl =
    origin && previewUrl.startsWith('/') ? `${origin}${previewUrl}` : previewUrl;

  function copyPreviewUrl() {
    navigator.clipboard?.writeText(absolutePreviewUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const saveTimer = useRef<number | null>(null);
  const initialMount = useRef(true);
  // What we last persisted. Compared to `draft` for the dirty check so the
  // indicator clears properly after a save instead of flipping straight
  // back to "Unsaved".
  const lastSaved = useRef<string>(JSON.stringify({ ...page, ...(workingCopy?.fields ?? {}) }));

  const dirty = useMemo(() => JSON.stringify(draft) !== lastSaved.current, [draft, status]);

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    if (!dirty) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void save();
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [draft]);

  /** Strip fields that must never ride along with a content write: status
   *  has its own deliberate action, timestamps are server-stamped. */
  function contentFields(d: Page): Record<string, unknown> {
    const { id: _id, status: _st, date_published: _dp, date_updated: _du, ...rest } =
      d as Page & Record<string, unknown>;
    return rest;
  }

  // Autosave — writes the working copy, never the canonical page.
  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/working-copy/page/${page.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(draft) }),
      });
      const responseData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(responseData.error ?? `Autosave failed (${res.status})`);
      }
      lastSaved.current = JSON.stringify(draft);
      setHasWc(true);
      setStatus('saved');
      reloadPreview();
      window.setTimeout(() => setStatus('idle'), 1500);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Autosave failed');
    }
  }

  // Deliberate Save — flush the latest draft into the working copy, then
  // COMMIT it server-side (revision snapshot, SEO transform, redirect
  // hygiene — the same path agents use via the v1 API).
  async function saveAll() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setStatus('saving');
    setError(null);
    try {
      const wcUrl = `/api/sites/${siteId}/working-copy/page/${page.id}`;
      const flush = await fetch(wcUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(draft) }),
      });
      if (!flush.ok) {
        const j = await flush.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Save failed (${flush.status})`);
      }
      const res = await fetch(wcUrl, { method: 'POST' });
      const responseData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(responseData.error ?? `Save failed (${res.status})`);
      }
      setHasWc(false);
      // Stamp date_updated AND move the dirty baseline in the same update,
      // otherwise the stamp re-dirties the draft and the autosave loop
      // immediately recreates the working copy we just promoted.
      setDraft((d) => {
        const updated = { ...d, date_updated: new Date().toISOString() };
        lastSaved.current = JSON.stringify(updated);
        return updated;
      });
      setSeoWarnings(Array.isArray(responseData.seo_warnings) ? responseData.seo_warnings : []);
      setStatus('saved');
      reloadPreview();
      window.setTimeout(() => setStatus('idle'), 1500);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function discardWc() {
    await fetch(`/api/sites/${siteId}/working-copy/page/${page.id}`, { method: 'DELETE' });
    window.location.reload();
  }

  async function changeStatus(next: string) {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/pages/${page.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Status change failed (${res.status})`);
      }
      setDraft((d) => {
        const updated = { ...d, status: next as Page['status'], date_updated: new Date().toISOString() };
        lastSaved.current = JSON.stringify(updated);
        return updated;
      });
      setStatus('saved');
      reloadPreview();
      window.setTimeout(() => setStatus('idle'), 1500);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Status change failed');
    }
  }

  function update<K extends keyof Page>(key: K, value: Page[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // After the AI chat edits this page, refetch and adopt the server's copy as
  // the new baseline. Otherwise the local draft (unchanged) would silently
  // overwrite the AI's changes on the next autosave.
  async function reloadFromServer() {
    try {
      const res = await fetch(`/api/sites/${siteId}/pages/${page.id}`);
      if (!res.ok) return;
      const fresh = (await res.json()) as Page;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      lastSaved.current = JSON.stringify(fresh);
      setDraft(fresh);
      reloadPreview();
    } catch {
      // Soft-fail: the chat already showed an "Edit page ↗" link the user can
      // click to land on a clean editor instance.
    }
  }

  const deviceWidths: Record<Device, string> = {
    desktop: '100%',
    tablet: '768px',
    mobile: '375px',
  };

  return (
    <div className="editor">
      <header className="editor__topbar">
        <div className="editor__title-row">
          <a href={`/app/sites/${siteId}/pages`} className="editor__back" title="Exit editor">← Exit editor</a>
          <input
            className="editor__title-input"
            value={draft.title}
            placeholder="Untitled"
            onChange={(e) => update('title', e.target.value)}
          />
          <span className="editor__slug">/{draft.slug}</span>
        </div>
        <div className="editor__actions">
          <DocStatus
            save={status}
            dirty={dirty || hasWc}
            error={error}
            pubStatus={draft.status}
            docUpdatedAt={draft.date_updated}
            lastDeployedAt={lastDeployedAt}
          />
          <PublishMenu
            siteId={siteId}
            pubStatus={draft.status}
            statusOptions={PAGE_STATUS_OPTIONS}
            hasUnsaved={dirty || hasWc}
            saving={status === 'saving'}
            onSave={saveAll}
            onDiscard={discardWc}
            onStatusChange={changeStatus}
            docUpdatedAt={draft.date_updated ?? null}
            lastDeployedAt={lastDeployedAt}
            previewUrl={previewUrl}
            liveUrl={liveUrl}
          />
        </div>
      </header>

      <div className="editor__body">
        <aside className="editor__sidebar">
          <nav className="editor__tabs">
            <button className={activeTab === 'content' ? 'is-active' : ''} onClick={() => setActiveTab('content')}>Content</button>
            <button className={activeTab === 'ai' ? 'is-active' : ''} onClick={() => setActiveTab('ai')}>AI</button>
            <button className={activeTab === 'blocks' ? 'is-active' : ''} onClick={() => setActiveTab('blocks')}>Blocks</button>
            <button className={activeTab === 'seo' ? 'is-active' : ''} onClick={() => setActiveTab('seo')}>SEO</button>
            <button className={activeTab === 'settings' ? 'is-active' : ''} onClick={() => setActiveTab('settings')}>Settings</button>
            <button className={activeTab === 'history' ? 'is-active' : ''} onClick={() => setActiveTab('history')}>History</button>
          </nav>

          {activeTab === 'content' && (
            <div className="stack">
              {seoWarnings.length > 0 && (
                <div className="editor__seo-warn">
                  <strong>SEO heads-up</strong>
                  <ul>
                    {seoWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="muted text-sm">
                HTML mode. The page body below is rendered inside the site's layout (header, footer, theme).
              </div>
              <div className="field">
                <label>Page HTML</label>
                <div className="editor__cm">
                  <CodeMirror
                    value={draft.html_content ?? ''}
                    onChange={(value) => update('html_content', value)}
                    extensions={[htmlLang({ autoCloseTags: true }), EditorView.lineWrapping]}
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      bracketMatching: true,
                      closeBrackets: true,
                      autocompletion: true,
                      indentOnInput: true,
                    }}
                    placeholder="<h1>Hello</h1>"
                    minHeight="360px"
                    style={{ fontSize: '0.85rem' }}
                  />
                </div>
              </div>
              <p className="muted text-sm">
                Tip: use the AI chat to draft and edit this HTML by describing changes in plain English.
              </p>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="editor__ai">
              <ChatInterface
                siteId={siteId}
                pages={[{ id: page.id, title: draft.title, slug: draft.slug, status: draft.status }]}
                activePage={{ id: page.id, title: draft.title, slug: draft.slug }}
                onActivePageMutated={reloadFromServer}
              />
            </div>
          )}

          {activeTab === 'blocks' && (
            <BlocksTab siteId={siteId} html={draft.html_content ?? ''} />
          )}

          {activeTab === 'seo' && (
            <div className="stack">
              <SerpPreview
                title={draft.seo_title || draft.title}
                description={draft.seo_description ?? ''}
                url={absolutePreviewUrl}
              />
              <OgPreview
                title={draft.seo_title || draft.title}
                description={draft.seo_description ?? ''}
                image={draft.og_image || undefined}
                imageAlt={draft.seo_image_alt || undefined}
                host={(() => {
                  try { return new URL(absolutePreviewUrl).hostname; } catch { return 'example.com'; }
                })()}
              />
              <div className="field">
                <label>Page kind</label>
                <select
                  value={draft.kind ?? 'page'}
                  onChange={(e) => update('kind', e.target.value as 'page' | 'article')}
                >
                  <option value="page">Page</option>
                  <option value="article">Article (blog post, news)</option>
                </select>
                <p className="muted text-sm">Articles emit Article schema + og:type=article + article:published_time.</p>
              </div>
              {draft.kind === 'article' && (
                <div className="field">
                  <label>Author name</label>
                  <input value={draft.author ?? ''} onChange={(e) => update('author', e.target.value)} placeholder="Jane Doe" />
                </div>
              )}
              <div className="field">
                <label>SEO title</label>
                <input value={draft.seo_title ?? ''} onChange={(e) => update('seo_title', e.target.value)} placeholder={draft.title} />
              </div>
              <label className="row text-sm">
                <input type="checkbox" checked={draft.append_seo_suffix !== false} onChange={(e) => update('append_seo_suffix', e.target.checked)} />
                Append the site SEO suffix
              </label>
              <div className="field">
                <label>Meta description</label>
                <textarea
                  value={draft.seo_description ?? ''}
                  onChange={(e) => update('seo_description', e.target.value)}
                  rows={3}
                />
              </div>
              <div className="field">
                <label>OG image URL</label>
                <input value={draft.og_image ?? ''} onChange={(e) => update('og_image', e.target.value)} />
                <p className="muted text-sm">Must be a raster image (PNG/JPG, ~1200×630). SVGs don't render correctly on most social platforms.</p>
              </div>
              <div className="field">
                <label>OG image alt text</label>
                <input
                  value={draft.seo_image_alt ?? ''}
                  onChange={(e) => update('seo_image_alt', e.target.value)}
                  placeholder="Falls back to the page's first <img alt> when blank."
                />
              </div>
              <div className="field">
                <label>Schema.org type</label>
                <input
                  value={draft.schema_type ?? ''}
                  onChange={(e) => update('schema_type', e.target.value)}
                  placeholder='e.g. "Service", "Course", "Product"'
                />
                <p className="muted text-sm">Emitted as JSON-LD alongside the auto Article/Breadcrumb schemas. Service uses the fields below.</p>
              </div>
              {draft.schema_type === 'Service' && (
                <div className="field">
                  <label>Service offer</label>
                  <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                    <input
                      style={{ flex: '1 1 8rem' }}
                      placeholder="Price"
                      value={String((draft.service?.price ?? ''))}
                      onChange={(e) => update('service', { ...(draft.service ?? {}), price: e.target.value })}
                    />
                    <input
                      style={{ flex: '0 0 6rem' }}
                      placeholder="Currency (SEK)"
                      value={draft.service?.price_currency ?? ''}
                      onChange={(e) => update('service', { ...(draft.service ?? {}), price_currency: e.target.value })}
                    />
                    <input
                      style={{ flex: '1 1 10rem' }}
                      placeholder='Duration (e.g. "2 veckor")'
                      value={draft.service?.duration ?? ''}
                      onChange={(e) => update('service', { ...(draft.service ?? {}), duration: e.target.value })}
                    />
                  </div>
                  <input
                    style={{ marginTop: '0.5rem' }}
                    placeholder="Short description (overrides meta description for Service schema)"
                    value={draft.service?.description ?? ''}
                    onChange={(e) => update('service', { ...(draft.service ?? {}), description: e.target.value })}
                  />
                </div>
              )}
              <div className="field">
                <label>Canonical URL (optional)</label>
                <input value={draft.canonical_url ?? ''} onChange={(e) => update('canonical_url', e.target.value)} />
              </div>
              <label className="row text-sm">
                <input type="checkbox" checked={draft.noindex ?? false} onChange={(e) => update('noindex', e.target.checked)} />
                Hide from search engines (noindex)
              </label>
              <div className="field">
                <label>JSON-LD structured data</label>
                <textarea
                  value={draft.json_ld ?? ''}
                  onChange={(e) => update('json_ld', e.target.value)}
                  rows={4}
                  spellCheck={false}
                  className="editor__code"
                />
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="stack">
              <div className="field">
                <label>Slug</label>
                <input value={draft.slug} onChange={(e) => update('slug', e.target.value)} />
              </div>
              <div className="field">
                <label>Page CSS</label>
                <textarea
                  value={draft.custom_css ?? ''}
                  onChange={(e) => update('custom_css', e.target.value)}
                  placeholder={'/* CSS just for this page — injected after the site CSS.\n   Put page-specific styling here instead of a <style> in an HTML block. */'}
                  spellCheck={false}
                  style={{ fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', minHeight: '60vh', resize: 'vertical', width: '100%' }}
                />
                <p className="muted text-sm">
                  Scoped to this page, injected into <code>&lt;head&gt;</code> after the
                  site-wide CSS so it can override the theme. This is page metadata —
                  keep styling here, not inside a content block.
                </p>
              </div>
              <TemplatePicker
                siteId={siteId}
                pageId={page.id}
                currentTemplate={draft.template}
              />
              <p className="muted text-sm">
                Status: <strong>{draft.status}</strong>
                {draft.date_published && <> · Published {new Date(draft.date_published).toLocaleDateString()}</>}
              </p>
              <ContentModeSwitcher siteId={siteId} pageId={page.id} currentMode="html" />
            </div>
          )}

          {activeTab === 'history' && (
            <HistoryPanel
              endpoint={`/api/sites/${siteId}/pages/${page.id}/revisions`}
              previewUrlFor={(revId) =>
                `/api/sites/${siteId}/pages/${page.id}/revisions/${revId}/preview`
              }
            />
          )}
        </aside>

        <section className="editor__preview-pane">
          <div className="editor__device-bar">
            <button onClick={() => setDevice('desktop')} className={device === 'desktop' ? 'is-active' : ''}>
              <Monitor size={15} /> Desktop
            </button>
            <button onClick={() => setDevice('tablet')} className={device === 'tablet' ? 'is-active' : ''}>
              <Tablet size={15} /> Tablet
            </button>
            <button onClick={() => setDevice('mobile')} className={device === 'mobile' ? 'is-active' : ''}>
              <Smartphone size={15} /> Mobile
            </button>
            <div className="editor__preview-url" title={absolutePreviewUrl}>
              <code>{absolutePreviewUrl}</code>
              <button
                type="button"
                onClick={copyPreviewUrl}
                title={copied ? 'Copied' : 'Copy preview URL'}
                className="editor__preview-url-copy"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <a href={previewUrl} target="_blank" rel="noopener" className="editor__open-preview">
              Open <ExternalLink size={13} />
            </a>
          </div>
          <div className="editor__preview-frame">
            <iframe
              ref={iframeRef}
              src={previewUrl + (previewUrl.includes('?') ? '&' : '?') + `embed=1&canvas=${encodeURIComponent(canvasId)}`}
              style={{ width: deviceWidths[device] }}
              title="Page preview"
            />
          </div>
        </section>
      </div>

      <style>{styles}</style>
    </div>
  );
}


interface BlocksTabProps {
  siteId: string;
  html: string;
}

/**
 * Lists the global blocks this page currently embeds via <x-include>.
 * Parsed live from the editor's draft HTML so adding or removing a block
 * reflects in this tab without a save round-trip. Each entry links to the
 * block's own editor so the user can jump to "the source of truth" for
 * shared content.
 */
function BlocksTab({ siteId, html }: BlocksTabProps) {
  const used = useMemo(() => listBlocksUsedInHtml(html), [html]);
  const [meta, setMeta] = useState<Record<string, { name?: string; kind?: string; status?: string; exists: boolean }>>({});

  useEffect(() => {
    let cancelled = false;
    if (used.length === 0) {
      setMeta({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        used.map(async (id) => {
          try {
            const res = await fetch(`/api/sites/${siteId}/partials/${id}`);
            if (!res.ok) return [id, { exists: false }] as const;
            const j = (await res.json()) as { name?: string; kind?: string; status?: string };
            return [id, { name: j.name, kind: j.kind, status: j.status, exists: true }] as const;
          } catch {
            return [id, { exists: false }] as const;
          }
        }),
      );
      if (!cancelled) setMeta(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId, used.join('|')]);

  return (
    <div className="stack">
      <div className="muted text-sm">
        Global blocks this page embeds via <code>&lt;x-include&gt;</code>. Edits to a
        block update every page that includes it.
      </div>
      {used.length === 0 ? (
        <div className="muted text-sm" style={{ padding: '0.5rem 0' }}>
          This page doesn't embed any free blocks yet. To share a piece of HTML
          across multiple pages, create a block in <a href={`/app/sites/${siteId}/partials`}>Global blocks</a>{' '}
          and add <code>&lt;x-include name="block-id" /&gt;</code> here.
        </div>
      ) : (
        <ul className="blocks-tab">
          {used.map((id) => {
            const m = meta[id];
            const missing = m?.exists === false;
            return (
              <li key={id} className={`blocks-tab__item ${missing ? 'blocks-tab__item--missing' : ''}`}>
                <div className="blocks-tab__row">
                  <code className="blocks-tab__id">{id}</code>
                  {m?.name && m.name !== id && <span className="blocks-tab__name">{m.name}</span>}
                  {m?.kind && <span className="blocks-tab__kind">{m.kind}</span>}
                  {m?.status === 'draft' && <span className="blocks-tab__status">draft</span>}
                </div>
                {missing ? (
                  <div className="blocks-tab__warn">
                    No block with this id exists yet. The include will render as
                    nothing until you{' '}
                    <a href={`/app/sites/${siteId}/partials`}>create it</a>.
                  </div>
                ) : (
                  <a
                    className="blocks-tab__edit"
                    href={`/app/sites/${siteId}/partials/${id}`}
                    target="_blank"
                    rel="noopener"
                  >
                    Edit block ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const styles = `
.editor { display: flex; flex-direction: column; height: calc(100vh - 4.5rem); margin: -2.25rem -2.5rem; }
.editor__topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.75rem 1.5rem; background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}
.editor__title-row { display: flex; align-items: center; gap: 0.75rem; flex: 1; }
.editor__back { font-size: 1.25rem; color: var(--color-text-muted); }
.editor__title-input {
  font-size: 1.125rem; font-weight: 600;
  border: 0; background: transparent; outline: none; flex: 1; max-width: 500px;
}
.editor__title-input:focus { background: var(--color-bg); }
.editor__slug { color: var(--color-text-muted); font-size: 0.875rem; }
.editor__actions { display: flex; align-items: center; gap: 0.75rem; }
.editor__status-select {
  padding: 0.375rem 0.625rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface);
}
.editor__body { display: grid; grid-template-columns: 380px minmax(0, 1fr); flex: 1; overflow: hidden; }
.editor__sidebar { padding: 1.25rem; overflow-y: auto; border-right: 1px solid var(--color-border); background: var(--color-surface); min-width: 0; }
/* Phone portrait + small tablets: stack vertically so each pane has room. */
@media (max-width: 900px) and (orientation: portrait) {
  .editor__body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; overflow: auto; }
  .editor__sidebar { border-right: 0; border-bottom: 1px solid var(--color-border); max-height: 60vh; }
}
/* Phone landscape: stacking would crush both panes (e.g. 844x390). Keep
   side-by-side but shrink the sidebar so the preview has breathing room. */
@media (max-width: 900px) and (orientation: landscape) {
  .editor__body { grid-template-columns: 280px minmax(0, 1fr); }
  .editor__sidebar { padding: 0.85rem; }
  .editor__html, .editor__code { min-height: 200px; }
}
/* Very tall narrow viewports (e.g. iPhone portrait 390x844): no change
   needed — portrait case already handled above. */
.editor__tabs { display: flex; gap: 0.25rem; margin-bottom: 1.25rem; border-bottom: 1px solid var(--color-border); }
.editor__tabs button {
  padding: 0.5rem 0.75rem; background: none; border: 0; cursor: pointer;
  color: var(--color-text-muted); font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.editor__tabs button.is-active { color: var(--color-text); border-bottom-color: var(--color-primary); }
.editor__html, .editor__code {
  font-family: var(--font-mono); font-size: 0.85rem; min-height: 360px;
  padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-bg); resize: vertical; width: 100%;
}
/* CodeMirror takes over for the HTML body — same chrome as the textareas
   it replaces, but with syntax highlighting + indents + bracket matching. */
.editor__cm {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}
.editor__cm .cm-editor {
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.editor__cm .cm-editor.cm-focused { outline: none; }
.editor__cm .cm-editor.cm-focused .cm-cursor { border-left-color: var(--color-primary); }
.editor__cm .cm-gutters {
  background: var(--color-bg);
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.editor__cm .cm-content { padding: 0.5rem 0; }
.editor__cm .cm-activeLine { background: rgba(15,23,42,0.025); }
.editor__cm .cm-activeLineGutter { background: rgba(15,23,42,0.04); color: var(--color-text); }
.editor__preview-pane { display: flex; flex-direction: column; background: var(--color-bg); overflow: hidden; }
.editor__device-bar {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 1rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface);
}
.editor__device-bar button {
  padding: 0.25rem 0.625rem; background: none; border: 0; cursor: pointer;
  font-size: 0.875rem; color: var(--color-text-muted); border-radius: var(--radius-sm);
  display: inline-flex; align-items: center; gap: 0.4rem;
}
.editor__device-bar a { display: inline-flex; align-items: center; gap: 0.35rem; }
.editor__device-bar button.is-active { background: var(--color-bg); color: var(--color-text); }
.editor__preview-url {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 0.25rem;
  max-width: 360px;
  background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 0.2rem 0.4rem 0.2rem 0.6rem;
  font-size: 0.78rem;
}
.editor__preview-url code {
  flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-family: var(--font-mono); color: var(--color-text-muted);
}
.editor__preview-url-copy {
  background: none; border: 0; cursor: pointer;
  color: var(--color-text-muted); padding: 0.15rem;
  display: inline-flex; border-radius: var(--radius-sm);
}
.editor__preview-url-copy:hover { color: var(--color-text); background: var(--color-surface); }
.editor__open-preview { font-size: 0.875rem; }
/* Embedded chat — make it fit the sidebar instead of using the full-page
   default height. The chat itself sets height: calc(100vh - 220px), which
   would overflow the editor sidebar; override locally. */
.editor__ai { margin: -0.25rem 0; }
.editor__ai .chat { height: calc(100vh - 12rem); max-width: none; }
.editor__ai .chat__thread { padding: 0.5rem 0; }
.editor__ai .chat__bubble { max-width: 100%; font-size: 0.875rem; }
.blocks-tab { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.blocks-tab__item {
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  padding: 0.6rem 0.75rem; background: var(--color-surface);
  display: flex; flex-direction: column; gap: 0.35rem;
}
.blocks-tab__item--missing { border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border)); }
.blocks-tab__row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.blocks-tab__id {
  font-family: var(--font-mono); font-size: 0.8rem;
  background: var(--color-bg); padding: 0.1rem 0.4rem; border-radius: var(--radius-sm);
}
.blocks-tab__name { font-size: 0.85rem; color: var(--color-text); }
.blocks-tab__kind, .blocks-tab__status {
  font-size: 0.7rem; padding: 0 0.35rem; border-radius: 4px;
  background: var(--color-bg); color: var(--color-text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.blocks-tab__edit { font-size: 0.8rem; }
.blocks-tab__warn { font-size: 0.8rem; color: var(--color-danger); }
.editor__seo-warn {
  background: color-mix(in srgb, #f6c177 12%, var(--color-surface));
  border: 1px solid color-mix(in srgb, #f6c177 40%, var(--color-border));
  border-radius: var(--radius-md);
  padding: 0.6rem 0.85rem;
  font-size: 0.85rem;
}
.editor__seo-warn strong { display: block; margin-bottom: 0.25rem; }
.editor__seo-warn ul { margin: 0; padding-left: 1.1rem; }
@media (max-width: 900px) {
  .editor__preview-url { display: none; }
  .editor__open-preview { margin-left: auto; }
}
.editor__preview-frame {
  flex: 1; display: flex; justify-content: center; align-items: stretch;
  padding: 1rem; overflow: auto;
}
.editor__preview-frame iframe {
  height: 100%; border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: white; box-shadow: var(--shadow-md); max-width: 100%;
}
`;
