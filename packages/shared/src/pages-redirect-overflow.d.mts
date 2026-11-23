import type { Redirect } from './types.js';
export const BULK_MARKER: string;
export function pagesBulkRedirects(text: string): Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[];
