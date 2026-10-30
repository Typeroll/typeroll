export const PAGES_REDIRECT_LIMITS: Readonly<{ static: number; dynamic: number; line: number }>;
export const MAX_PAGES_REDIRECT_BYTES: number;
export function checkPagesRedirects(text: string): { static: number; dynamic: number; total: number };
export function countPagesRedirectRules(text: string): { static: number; dynamic: number; total: number };
