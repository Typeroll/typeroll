import { useEffect, useRef, useState } from 'react';

/** Keep the editing DOM inert. Server-side publication sanitization still applies. */
export function editableHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowed = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'SPAN', 'SUB', 'SUP']);
  const clean = (node: Node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) return [document.createTextNode(node.textContent ?? '')];
    if (!(node instanceof HTMLElement)) return [];
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'TEMPLATE'].includes(node.tagName)) return [];
    const children = [...node.childNodes].flatMap(clean);
    if (!allowed.has(node.tagName)) return children;
    const element = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^(https?:|mailto:|tel:|\/|#)/i.test(href) && !href.startsWith('//')) element.setAttribute('href', href);
    }
    if (node.id) element.id = node.id;
    for (const key of ['color', 'backgroundColor'] as const) {
      const value = node.style[key];
      if (/^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(value)) element.style[key] = value;
    }
    if (node.tagName === 'OL' && /^-?\d+$/.test(node.getAttribute('start') ?? '')) element.setAttribute('start', node.getAttribute('start')!);
    element.append(...children);
    return [element];
  };
  const output = document.createElement('div');
  output.append(...[...template.content.childNodes].flatMap(clean));
  return output.innerHTML;
}

export default function RichTextInput({ id, label, required, value, onChange }: { id: string; label: string; required?: boolean; value: string; onChange: (html: string) => void }) {
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [sourceMode, setSourceMode] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    const original = document.createElement('template'), editable = document.createElement('template');
    original.innerHTML = value; editable.innerHTML = editableHtml(value);
    // Existing media, tables or custom markup must never disappear on blur or
    // while changing a neighboring word. Preserve the original as source when
    // this lightweight text editor cannot round-trip it losslessly.
    const unsupported = !original.content.isEqualNode(editable.content);
    setSourceMode(unsupported);
    if (editor.current && document.activeElement !== editor.current) { editor.current.innerHTML = editable.innerHTML; dirty.current = false; }
  }, [value, sourceMode]);
  const emit = () => { if (editor.current && dirty.current) { dirty.current = false; onChange(editableHtml(editor.current.innerHTML)); } };
  const command = (name: string, arg?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, arg);
    dirty.current = true;
    emit();
  };
  if (sourceMode) return <div>
    <p style={{ fontSize: '0.875rem' }}>This field contains HTML formatting that needs the source editor to preserve it.</p>
    <textarea id={id} aria-label={label} aria-required={required || undefined} value={value} onChange={event => onChange(event.target.value)} rows={10} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', fontFamily: 'monospace' }} />
  </div>;
  return <div style={{ border: '1px solid #3a3a42', borderRadius: 6, overflow: 'hidden' }}>
    <div role="toolbar" aria-label="Text formatting" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6 }}>
      {([['Bold', 'bold'], ['Italic', 'italic'], ['Bullets', 'insertUnorderedList'], ['Numbered', 'insertOrderedList'], ['Unlink', 'unlink']] as const).map(([label, action]) =>
        <button key={action} type="button" aria-label={label} onMouseDown={e => e.preventDefault()} onClick={() => command(action)} style={{ padding: '6px 8px' }}>{label}</button>)}
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => {
        const current = window.getSelection();
        selection.current = current?.rangeCount ? current.getRangeAt(0).cloneRange() : null;
        setLinkOpen(true);
      }}>Link</button>
    </div>
    {linkOpen && <div style={{ display: 'flex', gap: 6, padding: 6 }}><input aria-label="Link URL" placeholder="https:// or /page" value={href} onChange={e => setHref(e.target.value)} style={{ minWidth: 0, flex: 1 }} /><button type="button" onClick={() => {
      if (!/^(https?:|mailto:|tel:|\/|#)/i.test(href) || href.startsWith('//')) return;
      editor.current?.focus();
      if (selection.current) { const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(selection.current); }
      command('createLink', href); setLinkOpen(false); setHref('');
    }}>Apply</button><button type="button" onClick={() => setLinkOpen(false)}>Cancel</button></div>}

    <div id={id} aria-label={label} aria-required={required || undefined} ref={editor} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
      onInput={() => { dirty.current = true; emit(); }} onBlur={emit} onPaste={e => {
        e.preventDefault();
        const html = e.clipboardData.getData('text/html');
        if (html) command('insertHTML', editableHtml(html));
        else command('insertText', e.clipboardData.getData('text/plain'));
      }} style={{ minHeight: 140, padding: 12, background: '#19191f', color: '#eee', lineHeight: 1.6, overflowWrap: 'anywhere' }} />
  </div>;
}
