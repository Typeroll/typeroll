#!/usr/bin/env node

import { checkE2ETarget, resolveE2ETarget } from './lib/e2e-target.mjs';
import { reportError } from './lib/e2e-cli.mjs';

try {
  const target = resolveE2ETarget();
  const result = await checkE2ETarget(target);
  console.log(JSON.stringify({
    target: target.kind,
    portal_url: target.portalUrl,
    forms_url: target.formsUrl,
    core_version: result.version.core_version,
    image_digest: result.version.image_digest,
    status: 'ready',
  }, null, 2));
} catch (error) {
  reportError(error);
}
