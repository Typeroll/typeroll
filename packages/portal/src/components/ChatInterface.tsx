import { useEffect, useRef, useState } from 'react';
import { Paperclip, X, Image as ImageIcon } from 'lucide-react';

interface PageSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
}

interface ChatAttachment {
  cdn_url: string;
  filename: string;
  mime_type: string;
  alt_text?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  actions?: ChatAction[];
  error?: boolean;
}

interface ChatAction {
  type: string;
  description: string;
  target?: string;
  preview_url?: string;
}

/**
 * Render plain text with auto-linked URLs. Markdown links `[label](url)` and
 * bare http(s)://… both work. Output is React fragments — no innerHTML, so
 * label text from the model can never end up being treated as markup.
 */
function renderBubbleContent(text: string): React.ReactNode {
  if (!text) return null;
  // Match markdown links first, then plain URLs. The two alternations don't
  // overlap (the URL alt requires a leading boundary), so split on either.
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![[(])(https?:\/\/[^\s)]+)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const href = match[2] ?? match[3];
    const label = match[1] ?? match[3]!;
    nodes.push(
      <a key={`l-${key++}`} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface PendingAttachment {
  id: string;
  file: File;
  preview: string;
  status: 'uploading' | 'ready' | 'error';
  cdn_url?: string;
  error?: string;
}

interface ActivePage {
  id: string;
  title: string;
  slug: string;
}

interface Props {
  siteId: string;
  pages: PageSummary[];
  /** When set, the chat is scoped to a single page (e.g. inside the page editor).
   *  The server pins "this page" to it so edits go there without re-asking. */
  activePage?: ActivePage;
  /** Fired when an assistant turn returns at least one action targeting the
   *  active page. The host (e.g. HtmlPageEditor) can use this to reload the
   *  page so the user's local draft doesn't overwrite the AI's edits. */
  onActivePageMutated?: () => void;
}

const SUGGESTIONS_SITE = [
  'Update the homepage tagline',
  'Fix the typo on the About page',
  'Add a new page called Services',
  'Make the headline on the home page more punchy',
];

const SUGGESTIONS_PAGE = [
  'Make the headline punchier',
  'Improve the meta description',
  'Add a call-to-action at the bottom',
  'Rewrite this in a more friendly tone',
];

const ACCEPTED_MIME = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/;

export default function ChatInterface({ siteId, pages, activePage, onActivePageMutated }: Props) {
  const welcome = activePage
    ? `Hi! I'm here to help with "${activePage.title}". Ask for edits to the body, the SEO fields, or just describe what you want changed — I'll work on this page by default.`
    : `Hi! I can edit your site for you. There are ${pages.length} page${pages.length === 1 ? '' : 's'} here. Try one of the suggestions below, or describe what you want changed — you can also drop or paste an image straight into the chat.`;
  const suggestions = activePage ? SUGGESTIONS_PAGE : SUGGESTIONS_SITE;
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', role: 'assistant', content: welcome },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Robust autofocus: on mount, and again whenever we finish a turn so the
  // user can keep typing without grabbing the mouse.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const uploadsPending = pending.some((p) => p.status === 'uploading');
  const readyAttachments = pending.filter((p): p is PendingAttachment & { cdn_url: string } => p.status === 'ready' && !!p.cdn_url);

  async function uploadOne(file: File) {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const preview = URL.createObjectURL(file);
    setPending((p) => [...p, { id, file, preview, status: 'uploading' }]);

    try {
      const presign = await fetch(`/api/sites/${siteId}/media/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          size: file.size,
        }),
      });
      const presignData = await presign.json();
      if (!presign.ok) throw new Error(presignData.error ?? 'Failed to get upload URL');

      const put = await fetch(presignData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`R2 upload failed (${put.status})`);

      // Finalize: apply cache headers + generate AVIF/WebP variants.
      // Best-effort — chat attachments still work without variants, but
      // they ship the original PNG to every viewport without it.
      if (presignData.finalizeUrl) {
        try {
          await fetch(presignData.finalizeUrl, { method: 'POST' });
        } catch (e) {
          console.warn('[chat-media-finalize]', e);
        }
      }

      setPending((p) =>
        p.map((it) => (it.id === id ? { ...it, status: 'ready', cdn_url: presignData.cdnUrl } : it)),
      );
    } catch (e) {
      setPending((p) =>
        p.map((it) =>
          it.id === id ? { ...it, status: 'error', error: e instanceof Error ? e.message : 'Upload failed' } : it,
        ),
      );
    }
  }

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => ACCEPTED_MIME.test(f.type));
    for (const f of arr) void uploadOne(f);
  }

  function removePending(id: string) {
    setPending((p) => {
      const it = p.find((x) => x.id === id);
      if (it) URL.revokeObjectURL(it.preview);
      return p.filter((x) => x.id !== id);
    });
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && readyAttachments.length === 0) || busy || uploadsPending) return;

    const attachments: ChatAttachment[] = readyAttachments.map((a) => ({
      cdn_url: a.cdn_url,
      filename: a.file.name,
      mime_type: a.file.type,
    }));

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');

    // Clear the attachment strip immediately; we keep object URLs alive until
    // the message render also uses them. New thumbnails reload from cdn_url.
    pending.forEach((p) => URL.revokeObjectURL(p.preview));
    setPending([]);
    setBusy(true);

    try {
      const res = await fetch(`/api/sites/${siteId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          attachments: attachments.length > 0 ? attachments : undefined,
          active_page_id: activePage?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Chat failed');
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: data.reply,
          actions: data.actions,
        },
      ]);
      if (
        activePage &&
        onActivePageMutated &&
        Array.isArray(data.actions) &&
        data.actions.some((a: ChatAction) => a.target === activePage.id)
      ) {
        onActivePageMutated();
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: e instanceof Error ? e.message : 'Something went wrong.',
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`chat ${dragOver ? 'chat--dragover' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types?.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only flip off when leaving the chat container, not when crossing children
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="chat__thread" ref={threadRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`chat__msg chat__msg--${msg.role} ${msg.error ? 'chat__msg--error' : ''}`}>
            <div className="chat__bubble">
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="chat__bubble-atts">
                  {msg.attachments.map((a, i) => (
                    <a key={i} href={a.cdn_url} target="_blank" rel="noopener" className="chat__bubble-att">
                      <img src={a.cdn_url} alt={a.filename} />
                    </a>
                  ))}
                </div>
              )}
              {msg.content && (
                <div style={{ whiteSpace: 'pre-wrap' }}>{renderBubbleContent(msg.content)}</div>
              )}
              {msg.actions && msg.actions.length > 0 && (
                <div className="chat__actions">
                  {msg.actions.map((a, i) => (
                    <div key={i} className="chat__action">
                      <span className="chat__action-icon">✓</span>
                      <span className="chat__action-desc">{a.description}</span>
                      {a.target && (
                        <span className="chat__action-links">
                          {a.preview_url && (
                            <a
                              href={a.preview_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="chat__action-link"
                            >
                              Preview ↗
                            </a>
                          )}
                          <a
                            href={`/app/sites/${siteId}/pages/${a.target}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="chat__action-link"
                          >
                            Edit page ↗
                          </a>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="chat__msg chat__msg--assistant">
            <div className="chat__bubble">
              <div className="chat__typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div className="chat__suggestions">
          {suggestions.map((s) => (
            <button key={s} onClick={() => void send(s)} className="chat__suggestion">{s}</button>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="chat__atts">
          {pending.map((p) => (
            <div key={p.id} className={`chat__att chat__att--${p.status}`}>
              <img src={p.preview} alt={p.file.name} />
              {p.status === 'uploading' && <div className="chat__att-overlay">uploading…</div>}
              {p.status === 'error' && <div className="chat__att-overlay chat__att-overlay--err">{p.error ?? 'error'}</div>}
              <button type="button" className="chat__att-x" onClick={() => removePending(p.id)} aria-label="Remove">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="chat__input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <button
          type="button"
          className="chat__attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title="Attach image"
        >
          <Paperclip size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          placeholder={pending.length > 0 ? 'Describe what to do with the image…' : 'What should I do?'}
          className="chat__input"
          disabled={busy}
          autoFocus
        />
        <button
          type="submit"
          className="btn"
          disabled={busy || uploadsPending || (!input.trim() && readyAttachments.length === 0)}
        >
          {uploadsPending ? 'Uploading…' : 'Send'}
        </button>
      </form>

      {dragOver && (
        <div className="chat__drop">
          <ImageIcon size={36} />
          <div>Drop image to attach</div>
        </div>
      )}

      <style>{styles}</style>
    </div>
  );
}

const styles = `
.chat { display: flex; flex-direction: column; height: calc(100vh - 220px); max-width: 900px; position: relative; }
.chat__thread {
  flex: 1; overflow-y: auto; padding: 1rem 0;
  display: flex; flex-direction: column; gap: 0.75rem;
}
.chat__msg { display: flex; }
.chat__msg--user { justify-content: flex-end; }
.chat__msg--assistant { justify-content: flex-start; }
.chat__bubble {
  max-width: 75%; padding: 0.75rem 1rem;
  border-radius: var(--radius-lg); line-height: 1.45;
  background: var(--color-surface); border: 1px solid var(--color-border);
}
.chat__msg--user .chat__bubble {
  background: var(--color-primary); color: white; border-color: transparent;
}
.chat__msg--error .chat__bubble {
  background: rgba(220,38,38,0.08);
  color: var(--color-danger);
  border-color: rgba(220,38,38,0.2);
}
.chat__bubble-atts {
  display: flex; flex-wrap: wrap; gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.chat__bubble-att img {
  max-width: 140px; max-height: 140px;
  border-radius: var(--radius-sm); display: block;
}
.chat__actions {
  margin-top: 0.75rem; padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
  display: flex; flex-direction: column; gap: 0.5rem;
}
.chat__action {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.875rem;
}
.chat__action-icon { color: var(--color-success); }
.chat__action-desc { flex: 1; min-width: 0; }
.chat__action-links { display: inline-flex; gap: 0.5rem; flex-shrink: 0; }
.chat__action-link { font-size: 0.75rem; white-space: nowrap; }
.chat__suggestions {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  padding: 0.75rem 0;
}
.chat__suggestion {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--color-border); background: var(--color-surface);
  border-radius: 999px; cursor: pointer; font-size: 0.875rem;
}
.chat__suggestion:hover { background: var(--color-bg); }
.chat__atts {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  padding: 0.5rem 0;
}
.chat__att {
  position: relative; width: 64px; height: 64px;
  border-radius: var(--radius-sm); overflow: hidden;
  border: 1px solid var(--color-border);
}
.chat__att img { width: 100%; height: 100%; object-fit: cover; display: block; }
.chat__att--uploading img { opacity: 0.5; }
.chat__att--error { border-color: var(--color-danger); }
.chat__att-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.65rem; color: white; text-align: center;
  background: rgba(0,0,0,0.45);
  padding: 0.25rem;
}
.chat__att-overlay--err { background: rgba(220,38,38,0.75); }
.chat__att-x {
  position: absolute; top: 2px; right: 2px;
  background: rgba(0,0,0,0.55); color: white;
  border: 0; border-radius: 999px;
  width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0;
}
.chat__input-row {
  display: flex; gap: 0.5rem;
  min-width: 0;
  padding: 0.75rem 0; border-top: 1px solid var(--color-border);
}
.chat__attach-btn {
  width: 40px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  cursor: pointer;
}
.chat__attach-btn:hover:not(:disabled) { color: var(--color-text); }
.chat__attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.chat__input {
  flex: 1; min-width: 0; padding: 0.625rem 0.875rem;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  outline: none; background: var(--color-surface);
}
.chat__input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(15,23,42,0.08);
}
.chat__typing { display: inline-flex; gap: 4px; padding: 0.25rem 0; }
.chat__typing span {
  width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-muted);
  animation: chat-typing 1.2s infinite ease-in-out;
}
.chat__typing span:nth-child(2) { animation-delay: 0.2s; }
.chat__typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes chat-typing {
  0%,80%,100% { transform: scale(0.7); opacity: 0.5; }
  40% { transform: scale(1); opacity: 1; }
}
@media (max-width: 480px) {
  .chat { height: calc(100dvh - 190px); min-height: 28rem; }
  .chat__bubble { max-width: 88%; }
  .chat__input-row { gap: 0.375rem; }
  .chat__input { padding-inline: 0.625rem; }
  .chat__input-row > .btn { padding-inline: 0.75rem; }
}
.chat--dragover .chat__drop {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.75rem;
  background: rgba(15,23,42,0.04);
  border: 2px dashed var(--color-primary);
  border-radius: var(--radius-lg);
  color: var(--color-primary);
  font-weight: 500;
  pointer-events: none;
}
`;
