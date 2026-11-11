import type { ExtensionInstallation } from '@typeroll/shared';

/**
 * App contracts: proofs for a contract installation name its contract next to
 * the resolved release `version`, so one contract address can tell its
 * installations apart. Omitted for installations without a contract.
 */
export function contractClaim(installation: Pick<ExtensionInstallation, 'contract'>): { contract?: number } {
  return installation.contract !== undefined ? { contract: installation.contract } : {};
}
