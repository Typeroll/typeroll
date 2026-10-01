// Write-time checks for site and page custom CSS, shared by the UI, the v1
// API and MCP routes. Errors refuse the write; warnings travel back in the
// response so a caller sees them.

import { checkCustomCss, type CustomCssProblem } from '@typeroll/shared';

/** Why a custom_css value cannot be saved, or null. Empty and null clear it. */
export function customCssWriteError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'custom_css must be text';
  const errors = checkCustomCss(value).filter(problem => problem.severity === 'error');
  if (!errors.length) return null;
  return `Custom CSS cannot be saved: ${errors.map(problem => `line ${problem.line}: ${problem.message}`).join(' ')}`;
}

/** Warnings for a custom_css value that can be saved. */
export function customCssWarnings(value: unknown): CustomCssProblem[] {
  return typeof value === 'string' ? checkCustomCss(value).filter(problem => problem.severity === 'warning') : [];
}
