// `format: "linked_text"` for application email: plain text in which
// `[label](https://…)` is a link. Core builds both parts itself, so an app can
// hide a long URL behind a label without sending its own HTML.
//
// - Everything is escaped; only https links become <a href>.
// - A backslash escapes `[`, `]` and `\`, so apps can insert untrusted values
//   (a registrant's name, say) without creating links.
// - The plain-text part shows `label (url)`.

export type EmailBodyFormat = 'text' | 'linked_text';
export const EMAIL_BODY_FORMATS: readonly EmailBodyFormat[] = ['text', 'linked_text'];

type Piece = { text: string } | { label: string; url: string };

const LINK = /^\[((?:\\[\\[\]]|[^\\[\]\n])+)\]\((https:\/\/[^\s()<>"']+)\)/;

function pieces(source: string): Piece[] {
  const out: Piece[] = [];
  let text = '';
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char === '\\' && /[\\[\]]/.test(source[i + 1] ?? '')) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (char === '[') {
      const match = LINK.exec(source.slice(i));
      if (match && isHttps(match[2]!)) {
        if (text) out.push({ text });
        text = '';
        out.push({ label: match[1]!.replace(/\\([\\[\]])/g, '$1'), url: match[2]! });
        i += match[0].length;
        continue;
      }
    }
    text += char;
    i++;
  }
  if (text) out.push({ text });
  return out;
}

function isHttps(url: string): boolean {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The plain-text part: links read `label (url)`. */
export function linkedTextToPlain(source: string): string {
  return pieces(source).map((piece) => 'url' in piece ? `${piece.label} (${piece.url})` : piece.text).join('');
}

/** The HTML part: escaped text, paragraphs from blank lines, <br> from line breaks. */
export function linkedTextToHtml(source: string): string {
  const inline = pieces(source).map((piece) => 'url' in piece
    ? `<a href="${escapeHtml(piece.url)}">${escapeHtml(piece.label)}</a>`
    : escapeHtml(piece.text)).join('');
  const paragraphs = inline.replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, '<br>\n'))
    .filter((paragraph) => paragraph.trim() !== '');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">'
    + paragraphs.map((paragraph) => `<p style="margin:0 0 1em">${paragraph}</p>`).join('\n')
    + '</body></html>';
}
