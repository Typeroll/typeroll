// The Site's routed pages for link pickers, fetched once per Site per
// editor session (the list is small, and filtering happens in the browser).

export interface InternalPageOption { id: string; title: string; url: string; status?: string }

const internalPageRequests = new Map<string, Promise<InternalPageOption[]>>();

export function loadInternalPages(siteId: string): Promise<InternalPageOption[]> {
  const existing = internalPageRequests.get(siteId);
  if (existing) return existing;
  const request = fetch(`/api/sites/${encodeURIComponent(siteId)}/pages`)
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Page lookup failed')))
    .then((payload) => Array.isArray(payload.pages) ? payload.pages as InternalPageOption[] : [])
    .catch((error) => {
      internalPageRequests.delete(siteId);
      throw error;
    });
  internalPageRequests.set(siteId, request);
  return request;
}

/** Forget the cached list, e.g. after a page was created or renamed. */
export function clearInternalPages(siteId: string): void {
  internalPageRequests.delete(siteId);
}
