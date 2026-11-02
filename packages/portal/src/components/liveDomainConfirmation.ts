/**
 * After cutover the site's publication serves its live custom domain, so the
 * deploy routes refuse a production deploy without confirm_live_domains.
 * The Publish controls send it only after a confirmation that names the
 * live domains.
 */

export interface PublicationTargetsView {
  production: boolean;
  live_domains: string[];
  targets: string[];
}

export const LIVE_DOMAIN_CONFIRMATION_CODE = 'live_domain_confirmation_required';

/** The confirmation text for a deploy that publishes to live domains. */
export function liveDomainConfirmMessage(targets: Pick<PublicationTargetsView, 'live_domains' | 'targets'>): string {
  const others = targets.targets.filter(target => !targets.live_domains.includes(target));
  return `Publish to your live website ${targets.live_domains.join(', ')}?\n\n` +
    `Visitors of ${targets.live_domains.join(', ')}${others.length ? ` and ${others.join(', ')}` : ''} see the saved content as soon as the deploy finishes.`;
}

/**
 * POST a deploy. When the server reports live domains this confirmation did
 * not name (the site went live after the page loaded), ask again with them.
 */
export async function postDeploy(siteId: string, body: Record<string, unknown>): Promise<{ res: Response; data: any; cancelled?: true }> {
  const send = (payload: Record<string, unknown>) => fetch(`/api/sites/${siteId}/deploy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  let res = await send(body);
  let data = await res.json();
  if (!res.ok && data?.code === LIVE_DOMAIN_CONFIRMATION_CODE && Array.isArray(data.live_domains)) {
    if (!confirm(liveDomainConfirmMessage(data))) return { res, data, cancelled: true };
    res = await send({ ...body, confirm_live_domains: true });
    data = await res.json();
  }
  return { res, data };
}
