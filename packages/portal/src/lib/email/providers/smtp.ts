import type { EmailProvider } from '../provider';
import { sendViaSmtp } from '../smtp';

export const smtpProvider: EmailProvider = {
  type: 'smtp',
  label: 'SMTP',
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', type: 'number', default: 587 },
    { key: 'secure', label: 'TLS on connect (port 465)', type: 'boolean', default: false },
    { key: 'user', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'password', secret: true },
  ],
  send(config, msg) {
    return sendViaSmtp(
      {
        host: String(config.values.host ?? ''),
        port: Number(config.values.port ?? 587),
        secure: Boolean(config.values.secure),
        user: String(config.values.user ?? ''),
        password: String(config.values.password ?? ''),
      },
      msg,
    );
  },
};
