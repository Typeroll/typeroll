export const MAX_DIRECT_OUTPUT_BYTES: number;
export const DIRECT_RECEIPT: string;
export interface DirectReceipt { format: 1; target?: { account: string; project: string }; files: Record<string, { sha256: string; size: number }>; manifest: Record<string, string>; controls: Record<string, string> }
export function describeStaticOutput(root: string): Promise<Omit<DirectReceipt, 'format' | 'manifest'>>;
export function validateDirectReceipt(value: unknown): DirectReceipt;

export function availablePagesAssets(receipt: DirectReceipt, grant: { jwt: string; target: { account: string; project: string } }, fetchImpl?: typeof fetch): Promise<DirectReceipt['files']>;
export function reusedMediaReceipt(preparedFiles: unknown[], previous: DirectReceipt): DirectReceipt;
export function mergeDirectReceipt(description: Omit<DirectReceipt, 'format' | 'manifest'>, manifest: DirectReceipt['manifest'], reused: DirectReceipt, target: NonNullable<DirectReceipt['target']>): DirectReceipt;
export function retainPagesAssets(receipt: DirectReceipt, grant: { jwt: string }, fetchImpl?: typeof fetch): Promise<boolean>;
