import type { APIRoute } from 'astro';
import { json } from '../../../../lib/access';
import { DeliveryError } from '../../../../lib/email/delivery';
import { inboundRoutes, receiveSesEmail } from '../../../../lib/email/inbound';
import { readMailPayload, verifySesEnvelope } from '../../../../lib/email/ses-events';

export const POST: APIRoute = async ({ request }) => {
  if (!process.env.EMAIL_SES_INBOUND_ROUTES) return json({ error: 'Not found' }, 404);
  try {
    const body = JSON.parse(await readMailPayload(request, 1_000_000));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DeliveryError('Invalid incoming email event', 400);
    const { hostname, topic } = await verifySesEnvelope(body, [...new Set(inboundRoutes().map(r => r.topic))]);
    if (body.Type === 'SubscriptionConfirmation') {
      const response = await fetch(`https://${hostname}/`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({ Action: 'ConfirmSubscription', Version: '2010-03-31', TopicArn: topic, Token: String(body.Token) }) });
      if (!response.ok) throw new DeliveryError('Incoming email subscription confirmation failed', 503);
      return json({ received: true });
    }
    await receiveSesEmail(topic, JSON.parse(String(body.Message)));
    // Do not disclose aliases, targets or receipt identifiers on a public webhook.
    return json({ received: true });
  } catch (error) {
    return json({ error: error instanceof DeliveryError ? error.message : 'Incoming email event could not be processed' },
      error instanceof DeliveryError ? error.status : error instanceof SyntaxError ? 400 : 503);
  }
};
