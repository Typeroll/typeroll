export type ProviderClient = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export function createProviderClient(provider: 'GitHub' | 'Cloudflare', token: string, fetchImpl?: typeof fetch): ProviderClient;
export function githubInstallationClient(config: { appId: string; installationId: string; privateKey: string; owner: string }, fetchImpl?: typeof fetch): Promise<ProviderClient>;
export function assertInstallation(installation: any, config: { appId: string; installationId: string; owner: string }): void;
export class ProviderError extends Error { status: number; }
