import crypto from 'node:crypto';
import http from 'node:http';

const port = Number(process.env.PORT || 8787);
const clientId = process.env.TYPEROLL_CLIENT_ID || '';
const clientSecret = process.env.TYPEROLL_CLIENT_SECRET || '';
const extensionId = 'se.typeroll.example.quote-generator';
const eventSecret = process.env.TYPEROLL_EVENT_SECRET || '';
const trustedIssuers = new Map();
const deliveredEvents = new Set();
const quotes = new Map([
  ['demo-customer-token', { title: 'Wedding package', total: 'SEK 24,900', approved: false }],
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verifyJwt(token, jwks, expected = {}) {
  if (!token) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url'));
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
    const jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (!jwk || header.alg !== 'ES256') return null;
    if (expected.audience && claims.aud !== expected.audience) return null;
    if (expected.issuer && claims.iss !== expected.issuer) return null;
    if (expected.nonce && claims.nonce !== expected.nonce) return null;
    if (expected.tokenUse && claims.token_use !== expected.tokenUse) return null;
    const valid = crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), {
      key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(encodedSignature, 'base64url'));
    const now = Date.now() / 1000;
    return valid && claims.exp > now && claims.iat <= now + 30 ? claims : null;
  } catch {
    return null;
  }
}

function trustedAssertion(request, expectedTokenUse) {
  const token = request.headers['x-typeroll-installation-assertion'];
  if (typeof token !== 'string') return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url')); } catch { return null; }
  const trust = trustedIssuers.get(claims.iss);
  return trust ? verifyJwt(token, trust.jwks, {
    audience: extensionId,
    issuer: claims.iss,
    tokenUse: expectedTokenUse,
  }) : null;
}

function validEvent(request, rawBody) {
  if (!eventSecret) return false;
  const timestamp = String(request.headers['x-typeroll-timestamp'] || '');
  const provided = String(request.headers['x-typeroll-signature'] || '').replace(/^v1=/, '');
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(provided)) return false;
  const expected = crypto.createHmac('sha256', eventSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'GET' && url.pathname === '/assets/index.js') {
    response.writeHead(404); response.end('Serve ../frontend/index.js from your CDN.'); return;
  }
  if (request.method === 'POST' && url.pathname === '/typeroll/pair') {
    const input = JSON.parse(await body(request));
    const discovery = await fetch(input.discovery_url).then((value) => value.json());
    const jwks = await fetch(discovery.jwks_uri).then((value) => value.json());
    const fingerprint = crypto.createHash('sha256').update(canonicalJson(jwks)).digest('hex');
    const claims = fingerprint === input.jwks_fingerprint
      ? verifyJwt(input.assertion, jwks, { audience: extensionId, nonce: input.nonce, tokenUse: 'issuer_pairing', issuer: input.issuer })
      : null;
    if (!claims || claims.iss !== input.issuer || discovery.issuer !== input.issuer) return json(response, 401, { trusted: false });
    trustedIssuers.set(input.issuer, { jwks, fingerprint });
    return json(response, 200, { trusted: true, issuer: input.issuer, nonce: input.nonce, jwks_fingerprint: fingerprint });
  }
  if (request.method === 'POST' && url.pathname === '/admin/launch') {
    const form = new URLSearchParams(await body(request));
    const issuer = form.get('issuer');
    if (!issuer || (!trustedIssuers.has(issuer) && process.env.ALLOW_UNPAIRED_ISSUER !== '1')) return json(response, 403, { error: 'Issuer is not paired' });
    const exchanged = await fetch(`${issuer}/api/extensions/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: form.get('code'), client_id: clientId, client_secret: clientSecret }),
    });
    if (!exchanged.ok) return json(response, 401, { error: 'Launch code exchange failed' });
    const token = await exchanged.json();
    const trust = trustedIssuers.get(issuer);
    const claims = trust && verifyJwt(token.access_token, trust.jwks, { audience: extensionId, issuer });
    if (!claims || claims.installation_id !== form.get('installation_id')) return json(response, 401, { error: 'Invalid delegated user token' });
    response.writeHead(303, { Location: '/admin', 'Set-Cookie': `quote_admin=${token.access_token}; HttpOnly; Secure; SameSite=None; Path=/admin` });
    response.end(); return;
  }
  if (request.method === 'GET' && url.pathname === '/typeroll/quotes/current') {
    const assertion = trustedAssertion(request, 'installation');
    if (!assertion) return json(response, 401, { error: 'Invalid installation assertion' });
    const quote = quotes.get(url.searchParams.get('token'));
    return quote ? json(response, 200, quote) : json(response, 404, { error: 'Quote not found' });
  }
  if (request.method === 'POST' && url.pathname === '/typeroll/quotes/approve') {
    const assertion = trustedAssertion(request, 'installation');
    if (!assertion) return json(response, 401, { error: 'Invalid installation assertion' });
    const input = JSON.parse(await body(request));
    const quote = quotes.get(input.token);
    if (!quote) return json(response, 404, { error: 'Quote not found' });
    quote.approved = true;
    return json(response, 200, quote);
  }
  if (request.method === 'POST' && url.pathname === '/typeroll/events') {
    const raw = await body(request);
    const eventId = String(request.headers['x-typeroll-event-id'] || '');
    if (!validEvent(request, raw)) return json(response, 401, { error: 'Invalid event signature' });
    if (!eventId) return json(response, 400, { error: 'Missing event id' });
    if (!deliveredEvents.has(eventId)) {
      deliveredEvents.add(eventId);
      const event = JSON.parse(raw);
      console.log(`Received ${event.type} for installation ${event.installation_id}`);
    }
    return json(response, 200, { received: true });
  }
  json(response, 404, { error: 'Not found' });
});

server.listen(port, () => console.log(`Quote provider listening on ${port}`));
