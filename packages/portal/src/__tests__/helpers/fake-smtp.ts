// A scripted SMTP server behind the SmtpSocket interface, for offline tests.
import type { SmtpConnect, SmtpSocket } from '../../lib/email/smtp-client';

export interface FakeSmtpOptions {
  /** Extensions advertised after EHLO (before and after TLS). */
  extensions?: string[];
  /** Override a reply: return a full reply line, or null to use the default. */
  reply?: (command: string, state: FakeSmtpState) => string | null | undefined;
  /** Reject the socket open (connection refused). */
  refuse?: boolean;
  /** Close the connection instead of replying to the end of DATA. */
  dropAfterData?: boolean;
  password?: { user: string; password: string };
}

export interface FakeSmtpState {
  connects: Array<{ hostname: string; port: number; secureTransport: string }>;
  commands: string[];
  tls: boolean;
  tlsHostname?: string;
  authenticated: boolean;
  from?: string;
  recipients: string[];
  data?: string;
  closed: boolean;
}

export function fakeSmtp(options: FakeSmtpOptions = {}): { connect: SmtpConnect; state: FakeSmtpState } {
  const state: FakeSmtpState = { connects: [], commands: [], tls: false, authenticated: false, recipients: [], closed: false };
  const encoder = new TextEncoder(), decoder = new TextDecoder();

  const socketPair = (onLine: (line: string, send: (text: string) => void, socket: { close(): void }) => void, greeting?: string): SmtpSocket => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const send = (text: string) => { if (open) controller.enqueue(encoder.encode(text)); };
    const close = () => { if (open) { open = false; try { controller.close(); } catch { /* closed */ } } };
    let buffer = '';
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          onLine(line, send, { close });
        }
      },
    });
    if (greeting) send(greeting);
    const socket: SmtpSocket = {
      readable, writable,
      opened: options.refuse ? Promise.reject(new Error('refused')) : Promise.resolve(),
      close() { state.closed = true; close(); },
      startTls(tls) {
        state.tls = true; state.tlsHostname = tls?.expectedServerHostname;
        close();
        return socketPair(onLine);
      },
    };
    socket.opened?.catch(() => {});
    return socket;
  };

  let inData = false, dataLines: string[] = [];
  const handle = (line: string, send: (text: string) => void, socket: { close(): void }) => {
    if (inData) {
      if (line === '.') {
        inData = false; state.data = dataLines.join('\r\n');
        if (options.dropAfterData) { socket.close(); return; }
        send(options.reply?.('.', state) ?? '250 2.0.0 queued as internal-id-123\r\n');
      } else dataLines.push(line);
      return;
    }
    state.commands.push(line);
    const custom = options.reply?.(line, state);
    if (custom) { send(custom); return; }
    const verb = line.split(' ')[0]!.toUpperCase();
    const extensions = options.extensions ?? ['STARTTLS', 'AUTH PLAIN LOGIN'];
    if (verb === 'EHLO') {
      const lines = ['smtp.example.test greets you', ...extensions.filter(entry => !(state.tls && entry === 'STARTTLS'))];
      send(lines.map((entry, index) => `250${index === lines.length - 1 ? ' ' : '-'}${entry}\r\n`).join(''));
    } else if (verb === 'STARTTLS') send('220 2.0.0 Ready to start TLS\r\n');
    else if (verb === 'AUTH') {
      const [, method, initial] = line.split(' ');
      const expected = options.password ?? { user: 'user', password: 'secret' };
      if (method === 'PLAIN') {
        const ok = atob(initial ?? '') === `\0${expected.user}\0${expected.password}`;
        state.authenticated = ok; send(ok ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n');
      } else if (method === 'LOGIN') send('334 VXNlcm5hbWU6\r\n');
    } else if (state.commands.at(-2) === 'AUTH LOGIN') send('334 UGFzc3dvcmQ6\r\n');
    else if (state.commands.at(-3) === 'AUTH LOGIN') {
      const expected = options.password ?? { user: 'user', password: 'secret' };
      const ok = atob(state.commands.at(-2)!) === expected.user && atob(line) === expected.password;
      state.authenticated = ok; send(ok ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n');
    } else if (verb === 'MAIL') { state.from = /<(.*)>/.exec(line)?.[1]; send('250 2.1.0 Ok\r\n'); }
    else if (verb === 'RCPT') { state.recipients.push(/<(.*)>/.exec(line)![1]!); send('250 2.1.5 Ok\r\n'); }
    else if (verb === 'DATA') { inData = true; dataLines = []; send('354 End data with <CR><LF>.<CR><LF>\r\n'); }
    else if (verb === 'QUIT') { send('221 2.0.0 Bye\r\n'); socket.close(); }
    else send('502 5.5.2 Command not recognized\r\n');
  };

  const connect: SmtpConnect = (address, connectOptions) => {
    state.connects.push({ ...address, secureTransport: connectOptions.secureTransport });
    if (connectOptions.secureTransport === 'on') state.tls = true;
    return socketPair(handle, '220 smtp.example.test ESMTP internal-banner\r\n');
  };
  return { connect, state };
}
