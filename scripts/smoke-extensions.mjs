#!/usr/bin/env node
// Post-deploy smoke test for the Typeroll Extension issuer and public JWKS.
//
// Usage:
//   node scripts/smoke-extensions.mjs <revision-base-url> <public-issuer>
//   SMOKE_BASE_URL=... EXTENSION_EXPECTED_ISSUER=... node scripts/smoke-extensions.mjs
//
// The revision URL should be the raw Cloud Run URL. Discovery must advertise
// the stable public issuer, but both requests deliberately hit the revision
// URL so a stale custom-domain route cannot make a broken deploy look healthy.

const args = process.argv.slice(2);
const base = (args[0] || process.env.SMOKE_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const expectedIssuer = (args[1] || process.env.EXTENSION_EXPECTED_ISSUER || "")
  .trim()
  .replace(/\/+$/, "");

if (!base || !expectedIssuer) {
  console.error(
    "usage: node scripts/smoke-extensions.mjs <revision-base-url> <public-issuer>",
  );
  process.exit(2);
}

const discoveryUrl = `${base}/.well-known/typeroll-extension-issuer`;
const jwksUrl = `${base}/.well-known/jwks.json`;
const expectedProtocolVersion = 3;
const attempts = Number(process.env.SMOKE_ATTEMPTS || 8);
const delayMs = Number(process.env.SMOKE_DELAY_MS || 5000);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  requireValue(
    response.ok,
    `${url} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return valid JSON`);
  }
}

async function check() {
  const discovery = await fetchJson(discoveryUrl);
  requireValue(
    discovery.issuer === expectedIssuer,
    `issuer was ${discovery.issuer}, expected ${expectedIssuer}`,
  );
  requireValue(
    discovery.jwks_uri === `${expectedIssuer}/.well-known/jwks.json`,
    "jwks_uri does not match the issuer",
  );
  requireValue(
    discovery.token_endpoint === `${expectedIssuer}/api/extensions/token`,
    "token_endpoint does not match the issuer",
  );
  requireValue(
    discovery.protocol_version === expectedProtocolVersion,
    `protocol_version was ${discovery.protocol_version}, expected ${expectedProtocolVersion}`,
  );
  requireValue(
    Array.isArray(discovery.signing_algorithms_supported) &&
      discovery.signing_algorithms_supported.includes("ES256"),
    "ES256 is not advertised",
  );

  const jwks = await fetchJson(jwksUrl);
  requireValue(
    Array.isArray(jwks.keys) && jwks.keys.length > 0,
    "JWKS contains no keys",
  );
  const signingKey = jwks.keys.find(
    (key) =>
      key?.kty === "EC" &&
      key?.crv === "P-256" &&
      key?.alg === "ES256" &&
      key?.use === "sig",
  );
  requireValue(signingKey, "JWKS contains no ES256 P-256 signing key");
  requireValue(
    typeof signingKey.kid === "string" && signingKey.kid.length > 0,
    "signing key has no kid",
  );
  requireValue(
    typeof signingKey.x === "string" && typeof signingKey.y === "string",
    "signing key has no public coordinates",
  );
  requireValue(!("d" in signingKey), "JWKS leaked a private key parameter");
}

let lastError;
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    await check();
    console.log(
      `SMOKE OK: Extension issuer and JWKS are healthy (attempt ${attempt}/${attempts}).`,
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.log(
      `attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (attempt < attempts)
      await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

console.error(
  `SMOKE FAIL (${base}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
);
process.exit(1);
