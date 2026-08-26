// Thin fetch client for the Typeroll REST API. The MCP server is just a
// transport adapter — every tool delegates to one of these methods.
//
// Surface kept deliberately tiny so it's easy to reason about: get/post/
// patch/put/del + a path helper. Errors come back as a structured
// ApiError with the status and the parsed body so the caller can shape
// useful tool-result messages.

export interface ClientConfig {
  /** Base URL of the Typeroll portal, e.g. https://app.typeroll.com */
  baseUrl: string;
  /** typeroll_live_... bearer token */
  apiKey: string;
  /** Override fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API request failed (${status})`);
    this.status = status;
    this.body = body;
    this.name = 'ApiError';
  }
}

export class TyperollClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) throw new Error('baseUrl is required');
    if (!config.apiKey) throw new Error('apiKey is required');
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Build the full URL for a path (relative to /api/v1/sites/{siteId}/...) */
  private url(siteId: string, path: string, query?: Record<string, string | number | undefined>): string {
    const cleanPath = path.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/api/v1/sites/${encodeURIComponent(siteId)}/${cleanPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** Top-level URL (no siteId prefix) — used by GET /v1/sites only. */
  private rootUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const cleanPath = path.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/api/v1/${cleanPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!res.ok) {
      const message = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, parsed, message);
    }
    return parsed as T;
  }

  // ── Site-scoped helpers ────────────────────────────────────────────────
  get<T>(siteId: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', this.url(siteId, path, query));
  }
  post<T>(siteId: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('POST', this.url(siteId, path, query), body);
  }
  patch<T>(siteId: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('PATCH', this.url(siteId, path, query), body);
  }
  put<T>(siteId: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('PUT', this.url(siteId, path, query), body);
  }
  del<T>(siteId: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('DELETE', this.url(siteId, path, query));
  }

  // ── Root helpers ───────────────────────────────────────────────────────
  rootGet<T>(path: string): Promise<T> {
    return this.request<T>('GET', this.rootUrl(path));
  }
  rootPost<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', this.rootUrl(path), body);
  }
}
