/** Confirm the actual destination before enqueueing a publication from any editor. */
export async function confirmPublicationDestination(siteId: string, customerGit: boolean, defaultMessage: string): Promise<{ domain_candidate_revision?: string } | null> {
  let message = defaultMessage;
  let revision: string | undefined;
  if (customerGit) {
    const response = await fetch(`/api/sites/${siteId}/publishing/domains`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check the publication destination.');
    if (result.next_publication) {
      revision = result.next_publication.revision;
      message = `${result.next_publication.error}\n\nCurrent: ${result.next_publication.current_host ?? 'test address'}\nFuture: ${result.next_publication.future_host ?? 'Hosting Group address'}\n\nPrepare this candidate?`;
    }
  }
  return confirm(message) ? (revision ? { domain_candidate_revision: revision } : {}) : null;
}
