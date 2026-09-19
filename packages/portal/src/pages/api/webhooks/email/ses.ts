import type { APIRoute } from 'astro';
import { DeliveryError } from '../../../../lib/email/delivery';
import { processSesEnvelope, readMailPayload } from '../../../../lib/email/ses-events';
import { json } from '../../../../lib/access';

export const POST: APIRoute = async ({ request }) => {
  if (!process.env.EMAIL_SES_SNS_TOPICS) return json({ error: 'Not found' }, 404);
  try {
    let body: unknown;
    try { body = JSON.parse(await readMailPayload(request, 256_000)); }
    catch (error) { if (error instanceof DeliveryError) throw error; return json({ error: 'Invalid mail event' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid mail event' }, 400);
    await processSesEnvelope(body as Record<string, unknown>);
    return json({ received: true });
  } catch (error) {
    return json({ error: error instanceof DeliveryError ? error.message : 'Mail event could not be processed' }, error instanceof DeliveryError ? error.status : 503);
  }
};
