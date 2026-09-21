export interface VerificationCheck { route: string; status: 200 | 404; sha256?: string; size?: number }
export const PROBE_BYTES: number;
export const PROBE_FILE_BYTES: number;
export const PROBE_FILES: number;
export function staticControlsHash(controls: Record<string, string>): string;
export function changedStaticChecks(current: VerificationCheck[], previous?: VerificationCheck[], reuse?: boolean): VerificationCheck[];
export function publicStaticChecks(checks: VerificationCheck[], current?: VerificationCheck[]): VerificationCheck[];
export function selectStaticProbes(checks: VerificationCheck[], changed?: VerificationCheck[]): VerificationCheck[];
export function verifyResponseBody(response: Response, check: VerificationCheck, limit?: number, observe?: (bytes: number) => void): Promise<boolean>;
export function verifyCandidateCheck(origin: string, check: VerificationCheck, options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; observe?: (bytes: number) => void }): Promise<boolean>;
export function verifyCandidateBatch(plan: { origin: string; checks: VerificationCheck[] }, cursor: number, options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; observe?: (bytes: number) => void }): Promise<{ cursor: number; total: number }>;

export function needsMediaRetentionEvidence(checks: VerificationCheck[]): boolean;
