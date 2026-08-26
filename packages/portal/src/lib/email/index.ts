// Connector dispatch: resolve the provider, decrypt its secrets, and hand the
// message to the provider's send(). Adding a provider doesn't touch this file.

import type { EmailConnector } from '@typeroll/shared';
import { getProvider } from './provider';
import { resolveConnector } from './connector-config';
import './providers'; // register built-in providers
import type { EmailMessage, SendResult } from './types';

export type { EmailMessage, SendResult } from './types';
export { providerDescriptors } from './provider';

export async function sendViaConnector(
  connector: EmailConnector,
  msg: EmailMessage,
): Promise<SendResult> {
  if (!msg.html && !msg.text) return { ok: false, error: 'Email has no body' };
  const provider = getProvider(connector.type);
  if (!provider) return { ok: false, error: `Unknown email provider "${connector.type}"` };

  const resolved = resolveConnector(connector);
  if (typeof resolved === 'string') return { ok: false, error: resolved };

  // Fall back to the connector's default From / reply-to when unset.
  const message: EmailMessage = { ...msg, from: msg.from || resolved.from };
  if (!message.from) return { ok: false, error: 'No From address configured' };
  if (!message.replyTo && resolved.replyTo) message.replyTo = resolved.replyTo;

  return provider.send(resolved, message);
}
