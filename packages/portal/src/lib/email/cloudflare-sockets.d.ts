// Minimal types for the Workers TCP socket built-in used by the SMTP provider.
declare module 'cloudflare:sockets' {
  interface SocketOptions { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
  interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
    startTls(options?: { expectedServerHostname?: string }): Socket;
  }
  export function connect(address: string | { hostname: string; port: number }, options?: SocketOptions): Socket;
}
