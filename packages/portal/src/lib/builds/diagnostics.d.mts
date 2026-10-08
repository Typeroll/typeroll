export interface BuildDiagnostic { cause: string | null; lines: string[] }
export const DIAGNOSTIC_LINES: number;
export const DIAGNOSTIC_LINE_LENGTH: number;
export const DIAGNOSTIC_CAUSE_LENGTH: number;
export function redactDiagnosticLine(line: string, secrets?: Iterable<string>): string;
export function secretValues(value: unknown, found?: Set<string>): Set<string>;
export function diagnosticCause(lines: string[]): string | null;
export function buildDiagnostic(output: string | undefined, secrets?: Iterable<string>): BuildDiagnostic;
export function normalizeDiagnostic(value: unknown): BuildDiagnostic | undefined;
