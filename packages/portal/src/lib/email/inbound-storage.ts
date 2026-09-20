import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { InboundRoute } from './inbound';
import { DeliveryError } from './delivery';

export const INBOUND_MAX_BYTES = 10 * 1024 * 1024;
function client(route: InboundRoute) {
  let config: Record<string, unknown>;
  try { config = JSON.parse(process.env.EMAIL_SES_INBOUND_STORAGE ?? '{}'); }
  catch { throw new DeliveryError('Incoming email storage is unavailable', 503); }
  if (typeof config.access_key_id !== 'string' || !config.access_key_id || typeof config.secret_access_key !== 'string' || !config.secret_access_key)
    throw new DeliveryError('Incoming email storage is unavailable', 503);
  return new S3Client({ region: route.region, maxAttempts: 2, credentials: {
    accessKeyId: config.access_key_id, secretAccessKey: config.secret_access_key,
  } });
}
export function inboundObject(route: InboundRoute, message: Record<string, any>) {
  const action = message.receipt?.action;
  const key = `${route.prefix}${message.mail?.messageId}`;
  if (action?.type !== 'S3' || action.bucketName !== route.bucket || action.objectKey !== key || action.topicArn !== route.topic)
    throw new DeliveryError('Incoming email storage reference does not match its approved route', 403);
  return { Bucket: route.bucket, Key: key, ExpectedBucketOwner: route.topic.split(':')[4]! };
}
export async function loadInboundObject(route: InboundRoute, message: Record<string, any>): Promise<Buffer> {
  const reference = inboundObject(route, message); const s3 = client(route);
  try {
    const result = await s3.send(new GetObjectCommand(reference), { abortSignal: AbortSignal.timeout(30_000) });
    const body = result.Body;
    if (!body) throw new DeliveryError('Incoming email object is unavailable', 503);
    try {
      if (result.ContentLength !== undefined && result.ContentLength > INBOUND_MAX_BYTES) throw new DeliveryError('Incoming email is too large to forward', 413);
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > INBOUND_MAX_BYTES) throw new DeliveryError('Incoming email is too large to forward', 413);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally { if ('destroy' in body && typeof body.destroy === 'function') body.destroy(); }
  } finally { s3.destroy(); }
}
export async function deleteInboundObject(route: InboundRoute, message: Record<string, any>) {
  const reference = inboundObject(route, message); const s3 = client(route);
  try { await s3.send(new DeleteObjectCommand(reference), { abortSignal: AbortSignal.timeout(10_000) }); }
  finally { s3.destroy(); }
}
