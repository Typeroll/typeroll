// The Workers TCP socket factory. Loaded only on demand so Node (tests,
// tools) never imports the `cloudflare:sockets` built-in.
import { connect } from 'cloudflare:sockets';
import type { SmtpConnect } from './smtp-client';

export const cloudflareConnect: SmtpConnect = (address, options) => connect(address, options) as never;
