export interface AdminDescriptor {
  issuer: string; org_id: string; site_id: string; installation_id: string;
  version: string; permission: string; token: string; expires_at: number;
  native: { sdk_version: 1; script_url: string; script_sha256: string; api_base_url: string };
}

export interface PortalAppSdk {
  version: 1;
  context: Readonly<Omit<AdminDescriptor, 'token' | 'expires_at' | 'native'>>;
  signal: AbortSignal;
  request(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
  configuration: { read(): Promise<Record<string, unknown>>; save(config: Record<string, unknown>): Promise<void> };
  navigate(path: string): void;
  notify(message: string, kind?: 'success' | 'error'): void;
  setDirty(dirty: boolean): void;
}

export function appApiUrl(base: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw Error('Invalid app API path');
  const root = new URL(base.endsWith('/') ? base : base + '/');
  const url = new URL(path.slice(1), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password || url.hash) throw Error('Invalid app API path');
  return url.href;
}

export async function verifiedModuleSource(response: Response, expected: string): Promise<string> {
  if (!response.ok || !response.body) throw Error('App module could not be loaded');
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw Error('App module exceeds the size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== expected) throw Error('App module integrity check failed');
  return new TextDecoder().decode(bytes);
}

export async function mountNativeAdmin(root: HTMLElement): Promise<() => void> {
  const { siteId, installationId, pageId } = root.dataset;
  if (!siteId || !installationId || !pageId) throw Error('Missing app context');
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/extensions/${encodeURIComponent(installationId)}`;
  const abort = new AbortController(); let dirty = false; let cleanup: (() => void) | undefined;
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
  const links = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (dirty && link && !confirm('Leave without saving your changes?')) event.preventDefault();
  };
  const readJson = async (response: Response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(typeof body.error === 'string' ? body.error : 'The app request failed');
    return body;
  };
  const session = async (): Promise<AdminDescriptor> => readJson(await fetch(`${endpoint}/admin-session`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: pageId }), signal: abort.signal, redirect: 'error',
  }));
  try {
    const initial = await session();
    if (initial.native.sdk_version !== 1 || initial.site_id !== siteId || initial.installation_id !== installationId) throw Error('Unsupported app context');
    const checkedSession = async () => {
      const current = await session();
      if (current.org_id !== initial.org_id || current.version !== initial.version ||
        JSON.stringify(current.native) !== JSON.stringify(initial.native)) throw Error('App context changed. Reload this page.');
      return current;
    };
    const source = await verifiedModuleSource(await fetch(initial.native.script_url, { credentials: 'omit', redirect: 'error', signal: abort.signal }), initial.native.script_sha256);
    const blob = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    let module;
    try { module = await import(/* @vite-ignore */ blob); } finally { URL.revokeObjectURL(blob); }
    if (module.sdkVersion !== 1 || typeof module.mount !== 'function') throw Error('Unsupported app SDK');
    const notices = document.createElement('div'); notices.setAttribute('role', 'status'); notices.setAttribute('aria-live', 'polite');
    const content = document.createElement('div'); root.replaceChildren(notices, content);
    const sdk: PortalAppSdk = {
      version: 1, context: Object.freeze({ issuer: initial.issuer, org_id: initial.org_id, site_id: siteId,
        installation_id: installationId, version: initial.version, permission: initial.permission }), signal: abort.signal,
      async request(path, options = {}) {
        const current = await checkedSession();
        return readJson(await fetch(appApiUrl(current.native.api_base_url, path), {
          method: options.method ?? 'GET', credentials: 'omit', redirect: 'error', signal: abort.signal,
          headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json' },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }));
      },
      configuration: {
        async read() { await checkedSession(); return (await readJson(await fetch(endpoint, { signal: abort.signal, redirect: 'error' }))).config; },
        async save(config) {
          await checkedSession();
          await readJson(await fetch(endpoint, { method: 'PATCH', signal: abort.signal, redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) }));
          dirty = false;
        },
      },
      navigate(path) {
        const target = new URL(path, location.origin);
        const prefix = `/app/sites/${encodeURIComponent(siteId)}`;
        if (target.origin !== location.origin || !(target.pathname === prefix || target.pathname.startsWith(prefix + '/'))) throw Error('Navigation is outside this site');
        if (!dirty || confirm('Leave without saving your changes?')) location.assign(target.href);
      },
      notify(message, kind = 'success') { notices.textContent = message; notices.className = kind === 'error' ? 'alert alert--error' : 'alert alert--success'; },
      setDirty(value) { dirty = value; },
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', links, true);
    const result = await module.mount(content, sdk);
    if (typeof result === 'function') cleanup = result;
    return () => { abort.abort(); cleanup?.(); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', links, true); root.replaceChildren(); };
  } catch (error) {
    abort.abort(); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', links, true);
    root.textContent = error instanceof Error ? error.message : 'App unavailable'; root.setAttribute('role', 'alert');
    return () => {};
  }
}
