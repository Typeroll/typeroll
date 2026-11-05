// RFC 5322 / MIME composition for the SMTP provider: UTF-8 headers as
// encoded words, quoted-printable text and HTML, an optional inline
// iCalendar attachment. Output is 7-bit with CRLF line endings.

import type { EmailMessage } from './types';

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 wrapped at 76 characters. */
export function base64Lines(text: string): string {
  return bytesToBase64(encoder.encode(text)).replace(/.{76}(?=.)/g, '$&\r\n');
}

/** Quoted-printable (RFC 2045) of UTF-8 text, soft-wrapped at 76 characters. */
export function quotedPrintable(text: string): string {
  return text.replace(/\r?\n/g, '\n').split('\n').map((line) => {
    const bytes = encoder.encode(line);
    let out = '', width = 0;
    bytes.forEach((byte, index) => {
      const last = index === bytes.length - 1;
      const literal = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      const token = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      if (width + token.length > 75) { out += '=\r\n'; width = 0; }
      out += token; width += token.length;
    });
    return out;
  }).join('\r\n');
}

/** An RFC 2047 encoded word when the value is not plain printable ASCII. */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // Encoded words stay under 75 characters; split on whole characters.
  const words: string[] = [];
  let chunk = '';
  for (const char of clean) {
    if (encoder.encode(chunk + char).length > 45) { words.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${bytesToBase64(encoder.encode(word))}?=`).join('\r\n ');
}

/** The bare address of `Name <a@b>` or `a@b`. */
export function addressOf(value: string): string {
  const match = /<([^<>]+)>\s*$/.exec(value);
  return (match ? match[1]! : value).trim();
}

/** `Name <a@b>` with an encoded display name when needed. */
export function formatAddress(raw: string): string {
  const value = raw.replace(/[\r\n]+/g, ' ');
  const address = addressOf(value);
  const name = /^(.*?)\s*<[^<>]+>\s*$/.exec(value)?.[1]?.trim().replace(/^"(.*)"$/, '$1');
  if (!name) return address;
  if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeaderValue(name)} <${address}>`;
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name) ? `${name} <${address}>` : `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`;
}

/** Comma-separated address list, as stored for cc and bcc. */
export function addressList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export interface ComposeOptions {
  messageId: string;
  boundary: (index: number) => string;
  date?: Date;
}

/** The complete message text. Bcc is never written as a header. */
export function composeMessage(msg: EmailMessage, options: ComposeOptions): string {
  const headers: Array<[string, string]> = [
    ['From', formatAddress(msg.from)],
    ['To', addressList(msg.to).map(formatAddress).join(', ')],
  ];
  if (msg.cc) headers.push(['Cc', addressList(msg.cc).map(formatAddress).join(', ')]);
  if (msg.replyTo) headers.push(['Reply-To', formatAddress(msg.replyTo)]);
  headers.push(
    ['Subject', encodeHeaderValue(msg.subject)],
    ['Date', (options.date ?? new Date()).toUTCString().replace('GMT', '+0000')],
    ['Message-ID', options.messageId],
    ['MIME-Version', '1.0'],
  );
  if (msg.forwarded) {
    headers.push(['Auto-Submitted', 'auto-generated'], ['X-Auto-Response-Suppress', 'All'], ['X-Typeroll-Forwarded', '1']);
  }

  const textPart = (type: 'plain' | 'html', body: string) =>
    `Content-Type: text/${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(body)}`;
  const parts: string[] = [];
  if (msg.text) parts.push(textPart('plain', msg.text));
  if (msg.html) parts.push(textPart('html', msg.html));
  const multipart = (subtype: string, boundary: string, children: string[]) =>
    `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n` +
    children.map((child) => `--${boundary}\r\n${child}\r\n`).join('') + `--${boundary}--`;
  let body = parts.length === 1 ? parts[0]! : multipart('alternative', options.boundary(1), parts);
  if (msg.calendar) {
    const filename = msg.calendar.filename.replace(/[^A-Za-z0-9_.-]/g, '_');
    const calendar = `Content-Type: text/calendar; charset=utf-8; method=PUBLISH; name="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\n${base64Lines(msg.calendar.content)}`;
    body = multipart('mixed', options.boundary(0), [body, calendar]);
  }
  return `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n${body}\r\n`;
}
