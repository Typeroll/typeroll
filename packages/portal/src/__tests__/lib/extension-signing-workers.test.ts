import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionInstallation } from '@typeroll/shared';
import {
  extensionJwks,
  signCredentialProvisioningAssertion,
  signDelegatedExtensionToken,
  signInstallationAssertion,
  signIssuerPairingAssertion,
  signPublicExtensionToken,
  verifyDelegatedExtensionToken,
  verifyPublicExtensionToken,
} from '../../lib/extensions/auth';

// Workers' node:crypto refuses a KeyObject as `options.key` when a
// `dsaEncoding` is given ("must be of type string or an instance of
// ArrayBuffer, Buffer, TypedArray, DataView, or Object"). Every Extension JWT
// is ES256 with that option, so Node accepting it is not enough: hold every
// signer to what Workers accepts.
function refuseKeyObjects(original: (...args: any[]) => any) {
  return (...args: any[]) => {
    const options = args[2];
    if (options && typeof options === 'object' && options.key instanceof crypto.KeyObject) {
      throw new TypeError('The "options.key" property must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or Object. Received an instance of PrivateKeyObject');
    }
    return original(...args);
  };
}

const originalSign = crypto.sign.bind(crypto);
const originalVerify = crypto.verify.bind(crypto);

const installation = {
  id: 'inst_1', extension_id: 'com.vendor.app', developer_org_id: 'dev', owner_org_id: 'org', site_id: 'site',
  version: '1.0.0', status: 'enabled', granted_scopes: ['content:read'],
} as unknown as ExtensionInstallation;

describe('Extension signing on Workers', () => {
  beforeEach(() => {
    process.env.PORTAL_PUBLIC_URL = 'https://admin.customer.example';
    process.env.EXTENSION_SIGNING_PRIVATE_JWK = JSON.stringify(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));
    vi.spyOn(crypto, 'sign').mockImplementation(refuseKeyObjects(originalSign) as typeof crypto.sign);
    vi.spyOn(crypto, 'verify').mockImplementation(refuseKeyObjects(originalVerify) as typeof crypto.verify);
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.EXTENSION_SIGNING_PRIVATE_JWK; });

  it('signs and verifies every token without handing node:crypto a KeyObject', () => {
    expect(signInstallationAssertion({ installation, scopes: ['content:read'], correlationId: 'c1', version: '1.0.0' }).split('.')).toHaveLength(3);
    expect(signIssuerPairingAssertion({ installation, nonce: 'n' }).split('.')).toHaveLength(3);
    expect(signCredentialProvisioningAssertion({ installation, version: '1.0.0', credentialSha256: 'a'.repeat(64) }).split('.')).toHaveLength(3);
    const publicToken = signPublicExtensionToken({ installation, origin: 'https://customer.example' } as never);
    expect(verifyPublicExtensionToken(publicToken.token, installation.extension_id)).toMatchObject({ token_use: 'public_extension' });
    const delegated = signDelegatedExtensionToken({ token_use: 'portal_admin', aud: installation.extension_id, sub: 'user', org_id: 'org', site_id: 'site', installation_id: 'inst_1', developer_org_id: 'dev', permission: 'admin', scopes: [] });
    expect(verifyDelegatedExtensionToken(delegated.token, installation.extension_id)).toMatchObject({ sub: 'user' });
    expect(extensionJwks().keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(extensionJwks().keys[0]).not.toHaveProperty('d');
  });
});
