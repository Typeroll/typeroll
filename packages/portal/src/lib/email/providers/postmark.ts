import type { EmailProvider } from '../provider';
import { sendViaPostmark } from '../postmark';

export const postmarkProvider: EmailProvider = {
  type: 'postmark',
  label: 'Postmark',
  fields: [
    { key: 'server_token', label: 'Server token', type: 'password', secret: true, required: true },
    { key: 'message_stream', label: 'Message stream', type: 'text', placeholder: 'outbound', help: 'Defaults to "outbound".' },
  ],
  send(config, msg) {
    return sendViaPostmark(
      String(config.values.server_token ?? ''),
      config.values.message_stream ? String(config.values.message_stream) : undefined,
      msg,
    );
  },
};
