import { createHash } from 'node:crypto';
import { getStore } from '../datastore';
import type { MailScope } from './delivery';
import { paths } from '@typeroll/shared';
import { queueOptoutPath } from './optouts';
import { BodyTooLargeError, parseFormBody, readBoundedBody } from '../forms/request-body';

export async function emailQueueUnsubscribe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  let token: FormDataEntryValue | null;
  try {
    token = request.method === 'GET' ? url.searchParams.get('t') : (await parseFormBody(await readBoundedBody(request, 4096), request.headers.get('content-type') ?? ''))?.get('t') ?? null;
  } catch (error) {
    return new Response('This request could not be read.', { status: error instanceof BodyTooLargeError ? 413 : 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const record = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await getStore().getDoc<MailScope & { group: string; recipient_digest: string }>(`mail_queue_unsubscribe/${createHash('sha256').update(token).digest('hex')}`) : null;
  if (!record) return new Response('This unsubscribe link is not available.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!await getStore().getDoc(paths.site(record.orgId, record.siteId))) return new Response('This site is no longer available.', { status: 410, headers: { 'Cache-Control': 'no-store' } });
  const confirmed = request.method === 'POST';
  if (confirmed) await getStore().createDocIfMissing(queueOptoutPath(record, record.recipient_digest), { installation_id: record.installationId, group: record.group, created_at: Date.now() });
  // Link scanners get a confirmation, never a state change. No mailbox or
  // private edit token is disclosed; this opt-out affects only this group.
  const content = confirmed ? '<h1>You are unsubscribed</h1><p>You will not receive more emails in this category. Edit links you request yourself are unaffected.</p>'
    : `<h1>Unsubscribe from these emails</h1><p>This stops future emails in this category. It does not stop edit links you request yourself.</p><form method="post"><input type="hidden" name="t" value="${token}"><button type="submit">Confirm unsubscribe</button></form>`;
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title><body><main>${content}</main></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}
