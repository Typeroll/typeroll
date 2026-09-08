export type ProviderClient = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export function createProviderClient(provider: 'GitHub' | 'Cloudflare', token: string, fetchImpl?: typeof fetch): ProviderClient;
export function githubInstallationClient(config: { appId: string; installationId: string; privateKey: string; owner: string }, fetchImpl?: typeof fetch): Promise<ProviderClient>;
export function assertInstallation(installation: any, config: { appId: string; installationId: string; owner: string }): void;
export class ProviderError extends Error { constructor(provider: string, status: number, codes?: number[]); provider: string; status: number; codes: number[]; }
export function digest(value: string | Uint8Array): string;
export function publishTree(client: ProviderClient, options: { owner: string; repo: string; branch?: string; files: Record<string, string>; message: string }): Promise<{ commit: string; changed: boolean; branch: string }>;
export function pagesProjectBody(options: { owner: string; repo: string; repository: any; project: string }): any;
export function matchingDeployment(deployments: any[], target: { project: string; commit: string; branch: string }): any;
export function assertSuccessfulStaticDeployment(deployment: any, project?: any): void;
