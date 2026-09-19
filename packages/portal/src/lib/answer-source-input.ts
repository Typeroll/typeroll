import { WorkingCopyError } from './working-copy';

export type AnswerSources = Record<string, { source_url?: string; import_run_id?: string }>;
/** API callers may attach evidence, never choose their actor identity. */
export function validateAnswerSources(answerSources: unknown): asserts answerSources is AnswerSources | undefined {
  if (answerSources !== undefined) {
    if (!answerSources || typeof answerSources !== 'object' || Array.isArray(answerSources)) throw new WorkingCopyError('answer_sources must be a map of answer paths to source metadata', 400);
    for (const [path, source] of Object.entries(answerSources)) {
      if (!/^[a-z][a-z0-9_]*(?:\/[^\s]+)*$/.test(path) || !source || typeof source !== 'object' || Array.isArray(source) ||
          Object.keys(source).some(key => !['source_url', 'import_run_id'].includes(key))) throw new WorkingCopyError('Answer sources accept only source_url and import_run_id; actor identity is assigned by the server', 400);
      const meta = source as Record<string, unknown>;
      if (meta.source_url !== undefined) { try { if (typeof meta.source_url !== 'string' || meta.source_url.length > 4096) throw Error(); const url = new URL(meta.source_url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); } catch { throw new WorkingCopyError('source_url must be an HTTP(S) URL without credentials', 400); } }
      if (meta.import_run_id !== undefined && (typeof meta.import_run_id !== 'string' || meta.import_run_id.length > 200)) throw new WorkingCopyError('Invalid import_run_id', 400);
    }
  }
}
