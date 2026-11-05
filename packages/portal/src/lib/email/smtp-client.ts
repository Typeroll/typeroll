// A small SMTP submission client over a Workers TCP socket (`cloudflare:sockets`).
//
// Implicit TLS (465/2465) or STARTTLS, AUTH PLAIN/LOGIN, one message per
// connection. Errors carry stable codes (EAUTH, ETLS, EENVELOPE, …)
// and the reply code, never the server's text, so callers can map them to fixed
// messages. The socket factory is injectable: tests run a scripted server.

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened?: Promise<unknown>;
  close(): Promise<void> | void;
  startTls(options?: { expectedServerHostname?: string }): SmtpSocket;
}

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: false },
) => SmtpSocket;

export interface SmtpSession {
  host: string;
  port: number;
  /** TLS from the first byte (465); otherwise STARTTLS. */
  secure: boolean;
  user?: string;
  password?: string;
  connect: SmtpConnect;
  /** Name sent in EHLO. */
  clientName?: string;
  timeouts?: { connectMs?: number; greetingMs?: number; commandMs?: number };
}

export interface SmtpEnvelope { from: string; to: string[] }

export class SmtpError extends Error {
  constructor(readonly code: string, readonly responseCode?: number) {
    super(responseCode ? `SMTP ${code} (reply ${responseCode})` : `SMTP ${code}`);
    this.name = 'SmtpError';
  }
}

interface Reply { code: number; lines: string[] }

const encoder = new TextEncoder();

class Connection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';

  constructor(public socket: SmtpSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** Release the streams so the socket can be upgraded. */
  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  async write(text: string | Uint8Array) {
    await this.writer.write(typeof text === 'string' ? encoder.encode(text) : text);
  }

  private async line(deadline: number): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const value = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return value;
      }
      if (this.buffer.length > 4096) throw new SmtpError('EPROTOCOL');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SmtpError('ETIMEDOUT');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmtpError('ETIMEDOUT')), remaining); }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new SmtpError('ECONNECTION');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async reply(timeoutMs: number): Promise<Reply> {
    const deadline = Date.now() + timeoutMs;
    const lines: string[] = [];
    for (;;) {
      const line = await this.line(deadline);
      const match = /^(\d{3})([ -])(.*)$/.exec(line) ?? (/^\d{3}$/.test(line) ? [line, line, ' ', ''] : null);
      if (!match) throw new SmtpError('EPROTOCOL');
      lines.push(match[3]!);
      if (lines.length > 100) throw new SmtpError('EPROTOCOL');
      if (match[2] === ' ') return { code: Number(match[1]), lines };
    }
  }
}

function extensions(reply: Reply): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name) result.set(name.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return result;
}

const base64 = (text: string) => {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Escape lines that start with a dot and normalize line endings to CRLF. */
export function dotStuff(message: string): string {
  return message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

/**
 * Deliver one message. `message` is the complete RFC 5322 text (headers and
 * body, CRLF line endings). Resolves when the server accepted the DATA.
 */
export async function sendSmtpMessage(session: SmtpSession, envelope: SmtpEnvelope, message: string): Promise<void> {
  const timeouts = { connectMs: 10_000, greetingMs: 10_000, commandMs: 30_000, ...session.timeouts };
  const expect = async (connection: Connection, accepted: number[], code: string, timeout = timeouts.commandMs) => {
    const reply = await connection.reply(timeout);
    if (!accepted.includes(reply.code)) throw new SmtpError(code, reply.code);
    return reply;
  };
  const command = async (connection: Connection, line: string, accepted: number[], code: string) => {
    await connection.write(`${line}\r\n`);
    return expect(connection, accepted, code);
  };

  let socket: SmtpSocket;
  try {
    socket = session.connect({ hostname: session.host, port: session.port }, { secureTransport: session.secure ? 'on' : 'starttls', allowHalfOpen: false });
  } catch {
    throw new SmtpError('ECONNECTION');
  }
  let connection = new Connection(socket);
  try {
    if (socket.opened) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        socket.opened.catch(() => { throw new SmtpError(session.secure ? 'ETLS' : 'ECONNECTION'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmtpError('ETIMEDOUT')), timeouts.connectMs); }),
      ]).finally(() => clearTimeout(timer));
    }
    const greeting = await connection.reply(timeouts.greetingMs).catch((error) => {
      throw error instanceof SmtpError && error.code === 'EPROTOCOL' ? new SmtpError('EGREETING') : error;
    });
    if (greeting.code !== 220) throw new SmtpError('EGREETING', greeting.code);
    const name = session.clientName ?? 'localhost';
    let features = extensions(await command(connection, `EHLO ${name}`, [250], 'EPROTOCOL'));

    if (!session.secure) {
      if (features.has('STARTTLS')) {
        await command(connection, 'STARTTLS', [220], 'ETLS');
        connection.release();
        try { socket = socket.startTls({ expectedServerHostname: session.host }); }
        catch { throw new SmtpError('ETLS'); }
        connection = new Connection(socket);
        if (socket.opened) await socket.opened.catch(() => { throw new SmtpError('ETLS'); });
        features = extensions(await command(connection, `EHLO ${name}`, [250], 'EPROTOCOL'));
      } else if (session.user) {
        // Never send credentials over a plain connection.
        throw new SmtpError('ETLS');
      }
    }

    if (session.user) {
      const methods = (features.get('AUTH') ?? '').split(/\s+/);
      if (methods.includes('PLAIN')) {
        await command(connection, `AUTH PLAIN ${base64(`\0${session.user}\0${session.password ?? ''}`)}`, [235], 'EAUTH');
      } else if (methods.includes('LOGIN')) {
        await command(connection, 'AUTH LOGIN', [334], 'EAUTH');
        await command(connection, base64(session.user), [334], 'EAUTH');
        await command(connection, base64(session.password ?? ''), [235], 'EAUTH');
      } else {
        throw new SmtpError('EAUTH_UNSUPPORTED');
      }
    }

    const utf8 = features.has('SMTPUTF8') && /[^\x00-\x7f]/.test([envelope.from, ...envelope.to].join(''));
    await command(connection, `MAIL FROM:<${envelope.from}>${utf8 ? ' SMTPUTF8' : ''}`, [250], 'EENVELOPE');
    for (const recipient of envelope.to) await command(connection, `RCPT TO:<${recipient}>`, [250, 251], 'EENVELOPE');
    await command(connection, 'DATA', [354], 'EMESSAGE');
    const body = dotStuff(message);
    // From here a lost connection leaves acceptance unknown: the server may
    // have queued the message before its reply was lost.
    try {
      await connection.write(body.endsWith('\r\n') ? `${body}.\r\n` : `${body}\r\n.\r\n`);
      await expect(connection, [250], 'EMESSAGE');
    } catch (error) {
      if (error instanceof SmtpError && error.responseCode) throw error;
      throw new SmtpError('EUNCONFIRMED');
    }
    // The message is accepted; a failed QUIT changes nothing.
    await connection.write('QUIT\r\n').then(() => connection.reply(2000)).catch(() => {});
  } finally {
    try { await socket.close(); } catch { /* already closed */ }
  }
}
