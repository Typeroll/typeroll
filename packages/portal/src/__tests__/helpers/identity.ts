// Test helpers for Better Auth instances over an in-memory SQL store.
import type { ReadWriteStore } from '../../lib/datastore';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { SqlStore, localTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';

export const ORIGIN = 'https://portal.example.test';
let counter = 0;

export function memoryStore(): ReadWriteStore {
  return new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver())), () => `id${++counter}`.padStart(8, '0'));
}

/** A tiny browser: keeps cookies between requests and sends the portal origin. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly handler: (request: Request) => Promise<Response>, private readonly ip = '203.0.113.7', private readonly origin = ORIGIN) {}
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const headers = new Headers({ origin: this.origin, 'cf-connecting-ip': this.ip });
    if (this.cookies.size) headers.set('cookie', this.cookieHeader());
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.handler(new Request(`${this.origin}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: 'manual',
    }));
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const [name, ...value] = pair!.split('=');
      const expired = attributes.some(a => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value.join('=') === '') this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value.join('='));
    }
    return response;
  }
  post(path: string, body: unknown = {}) { return this.request(path, { method: 'POST', body }); }
}

