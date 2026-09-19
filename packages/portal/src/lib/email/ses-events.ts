import { verify, X509Certificate } from 'node:crypto';
import { applyDeliveryEvent, DeliveryError } from './delivery';

/** Bound streamed bytes, including requests without Content-Length. */
export async function readMailPayload(input: Request | Response, maxBytes: number): Promise<string> {
  if (Number(input.headers.get('content-length')) > maxBytes) throw new DeliveryError('Mail event too large', 413);
  const reader = input.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new DeliveryError('Mail event too large', 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const certificates = new Map<string, { pem: string; expires: number }>();
async function certificate(url: string): Promise<string> {
  const cached = certificates.get(url);
  if (cached && cached.expires > Date.now()) return cached.pem;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new DeliveryError('Could not verify provider certificate', 503);
  const pem = await readMailPayload(response, 32_000);
  if (certificates.size >= 10) certificates.clear();
  certificates.set(url, { pem, expires: Date.now() + 3_600_000 });
  return pem;
}

/** Exact topic allowlist and AWS certificate host are checked before network I/O. */
export async function verifySesEnvelope(body: Record<string, unknown>, topics: string[], loadCertificate = certificate) {
  const topic = typeof body.TopicArn === 'string' ? body.TopicArn : '';
  const match = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:[A-Za-z0-9_-]+$/.exec(topic);
  if (!topics.includes(topic) || !match || !['Notification', 'SubscriptionConfirmation'].includes(String(body.Type))) throw new DeliveryError('Untrusted mail event', 403);
  let cert: URL;
  try { cert = new URL(String(body.SigningCertURL)); } catch { throw new DeliveryError('Invalid mail signature', 403); }
  const hostname = `sns.${match[1]}.amazonaws.com`;
  if (cert.protocol !== 'https:' || cert.hostname !== hostname || cert.port || cert.username || cert.password || cert.search || cert.hash ||
      !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(cert.pathname)) throw new DeliveryError('Invalid mail certificate URL', 403);
  const keys = body.Type === 'Notification'
    ? ['Message', 'MessageId', ...(body.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  if (keys.some(key => typeof body[key] !== 'string') || typeof body.Signature !== 'string' || !['1', '2'].includes(String(body.SignatureVersion))) throw new DeliveryError('Invalid mail signature', 403);
  const timestamp = Date.parse(String(body.Timestamp));
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300_000) throw new DeliveryError('Invalid mail timestamp', 403);
  const pem = await loadCertificate(cert.href);
  const x509 = new X509Certificate(pem);
  if (Date.now() < Date.parse(x509.validFrom) || Date.now() > Date.parse(x509.validTo)) throw new DeliveryError('Expired mail certificate', 403);
  const valid = verify(body.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1',
    Buffer.from(keys.map(key => `${key}\n${body[key]}\n`).join('')), x509.publicKey, Buffer.from(body.Signature, 'base64'));
  if (!valid) throw new DeliveryError('Invalid mail signature', 403);
  return { hostname, topic };
}

export async function processSesEnvelope(body: Record<string, unknown>) {
  const topics = (process.env.EMAIL_SES_SNS_TOPICS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const { hostname, topic } = await verifySesEnvelope(body, topics);
  if (body.Type === 'SubscriptionConfirmation') {
    // Never follow the supplied SubscribeURL. Only confirm the configured topic
    // through the region endpoint whose signature has just been verified.
    const response = await fetch(`https://${hostname}/`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(5000), body: new URLSearchParams({ Action: 'ConfirmSubscription', Version: '2010-03-31',
        TopicArn: topic, Token: String(body.Token) }) });
    if (!response.ok) throw new DeliveryError('Mail event subscription confirmation failed', 503);
    return;
  }
  let message: Record<string, any>;
  try { message = JSON.parse(String(body.Message)); } catch { throw new DeliveryError('Invalid mail event payload', 400); }
  if (!message || typeof message !== 'object') throw new DeliveryError('Invalid mail event payload', 400);
  const types: Record<string, 'delivered' | 'bounced' | 'complained' | 'failed'> = { Delivery: 'delivered', Bounce: 'bounced', Complaint: 'complained', Reject: 'failed', 'Rendering Failure': 'failed' };
  const type = types[String(message.eventType)];
  if (!type) return;
  const deliveryId = message.mail?.tags?.typeroll_delivery?.[0];
  const providerId = message.mail?.messageId;
  if (typeof deliveryId !== 'string' || typeof providerId !== 'string') return;
  await applyDeliveryEvent({ id: String(body.MessageId), deliveryId, providerId, provider: 'ses', type,
    at: String(body.Timestamp), suppress: type === 'complained' || (type === 'bounced' && message.bounce?.bounceType === 'Permanent') });
}
