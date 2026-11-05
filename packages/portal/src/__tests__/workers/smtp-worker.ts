// A minimal Worker that sends one message through the SMTP client over
// `cloudflare:sockets`, for the workerd socket test.
import { sendSmtpMessage } from '../../lib/email/smtp-client';
import { cloudflareConnect } from '../../lib/email/cloudflare-socket';

export default {
  async fetch(request: Request) {
    const port = Number(new URL(request.url).searchParams.get('port'));
    try {
      await sendSmtpMessage({ host: '127.0.0.1', port, secure: false, connect: cloudflareConnect },
        { from: 'site@example.com', to: ['a@example.net'] }, 'Subject: hi\r\n\r\n.dot\r\nbody\r\n');
      return new Response('sent');
    } catch (error) {
      return new Response(`error ${(error as { code?: string }).code}`, { status: 502 });
    }
  },
};
