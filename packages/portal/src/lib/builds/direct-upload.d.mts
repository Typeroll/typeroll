export const UPLOAD_CHUNK_BYTES: number;
export const UPLOAD_CHUNK_FILES: number;
export const DIRECT_RECEIPT: string;
export interface DirectReceipt { format: 1; target?: { account: string; project: string }; files: Record<string, { sha256: string; size: number }>; manifest: Record<string, string>; controls: Record<string, string> }
export function describeStaticOutput(root: string): Promise<Omit<DirectReceipt, 'format' | 'manifest'>>;
export function validateDirectReceipt(value: unknown): DirectReceipt;

export function availablePagesAssets(receipt: DirectReceipt, grant: { jwt: string; target: { account: string; project: string } }, fetchImpl?: typeof fetch): Promise<DirectReceipt['files']>;
export function reusedMediaReceipt(preparedFiles: unknown[], previous: DirectReceipt): DirectReceipt;
export function mergeDirectReceipt(description: Omit<DirectReceipt, 'format' | 'manifest'>, manifest: DirectReceipt['manifest'], reused: DirectReceipt, target: NonNullable<DirectReceipt['target']>): DirectReceipt;
export function retainPagesAssets(receipt: DirectReceipt, grant: { jwt: string }, fetchImpl?: typeof fetch): Promise<boolean>;
export function planUploadChunks(files: DirectReceipt['files'], limits?: { maxBytes?: number; maxFiles?: number }): string[][];
export function withUploadChunk<T>(root: string, directory: string, names: string[], upload: (directory: string) => Promise<T>): Promise<T>;
