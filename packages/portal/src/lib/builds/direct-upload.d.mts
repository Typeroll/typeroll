export const MAX_DIRECT_OUTPUT_BYTES: number;
export const DIRECT_RECEIPT: string;
export interface DirectReceipt { format: 1; files: Record<string, { sha256: string; size: number }>; manifest: Record<string, string>; controls: Record<string, string> }
export function describeStaticOutput(root: string): Promise<Omit<DirectReceipt, 'format' | 'manifest'>>;
export function validateDirectReceipt(value: unknown): DirectReceipt;
