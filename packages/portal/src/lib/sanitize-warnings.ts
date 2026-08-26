// Heuristic diff between pre- and post-sanitization HTML so write responses
// can surface what was stripped without forcing the caller to fetch the doc
// back and diff it themselves.
//
// Not exhaustive — sanitize-html doesn't expose "what got stripped" hooks
// directly, so we look for the categories that actually bite agents: script
// smuggling, event handlers, javascript: URLs, disallowed iframes. For
// each, we count occurrences in the input and confirm they're gone in the
// output. Two shapes returned:
//   - `messages`: human-readable strings (legacy field name, kept stable
//     for older clients)
//   - `details`: structured records `{ kind, count, bytes? }` for agents
//     and the editor UI to render specifically

export type SanitizationWarningKind =
  | 'script'
  | 'event-handler'
  | 'javascript-url'
  | 'iframe'
  | 'object'
  | 'embed'
  | 'form-handler'
  | 'css-exploit'
  | 'x-include'
  | 'x-form'
  | 'x-extension'
  | 'microdata'
  | 'unknown';

export interface SanitizationWarningDetail {
  kind: SanitizationWarningKind;
  /** What was removed, human-readable. */
  label: string;
  /** Number of occurrences stripped. >= 1. */
  count: number;
  /** Approx bytes removed. Only set for the 'unknown' catch-all. */
  bytes?: number;
}

export interface SanitizationDiff {
  /** Legacy human-readable warnings array. Same content as details.label. */
  messages: string[];
  details: SanitizationWarningDetail[];
}

const PATTERNS: Array<{ kind: SanitizationWarningKind; re: RegExp; label: string }> = [
  { kind: 'script', re: /<script[\s>]/gi, label: '<script> tag(s)' },
  { kind: 'event-handler', re: /\son[a-z]+\s*=/gi, label: 'inline event handler(s)' },
  { kind: 'javascript-url', re: /\bjavascript:/gi, label: 'javascript: URL(s)' },
  { kind: 'iframe', re: /<iframe[\s>]/gi, label: '<iframe> tag(s)' },
  { kind: 'object', re: /<object[\s>]/gi, label: '<object> tag(s)' },
  { kind: 'embed', re: /<embed[\s>]/gi, label: '<embed> tag(s)' },
  { kind: 'form-handler', re: /\sformaction\s*=/gi, label: 'formaction handler(s)' },
  // <x-include> is a first-class partial reference. The sanitizer SHOULD
  // keep it (allowedTags now includes it), but if a future config drift
  // strips it again this catches the regression with a structured kind.
  { kind: 'x-include', re: /<x-include[\s>]/gi, label: '<x-include> partial reference(s)' },
  { kind: 'x-form', re: /<x-form[\s>]/gi, label: '<x-form> form reference(s)' },
  { kind: 'x-extension', re: /<x-extension[\s>]/gi, label: '<x-extension> Extension reference(s)' },
  // Schema.org microdata: itemscope/itemtype/itemprop. `itemscope` is a
  // boolean attr (no value); the others take values. Match both shapes.
  // The sanitizer now keeps these by default — this pattern catches a
  // future regression with a structured kind. Surface explicitly so
  // agents know to switch to Page.json_ld if it ever happens again.
  { kind: 'microdata', re: /\sitem(?:scope|type|prop|ref|id)\b/gi, label: 'Schema.org microdata attribute(s) — consider Page.json_ld instead' },
  // CSS-content scrubbing markers — present in `after` only, the input
  // had the live exploit. We invert the count direction for these.
  { kind: 'css-exploit', re: /\/\* (?:expression\(\)|behavior:url|-moz-binding|@import|javascript:) stripped \*\//gi, label: 'unsafe CSS construct(s)' },
];

/**
 * Compare before/after sanitization HTML and return what got removed.
 *
 * @param before The HTML the caller submitted
 * @param after  The HTML after sanitizeBody() ran
 */
export function diffSanitizationDetails(before: string, after: string): SanitizationDiff {
  if (!before || before === after) return { messages: [], details: [] };

  const details: SanitizationWarningDetail[] = [];

  for (const { kind, re, label } of PATTERNS) {
    re.lastIndex = 0;
    const beforeCount = (before.match(re) ?? []).length;
    re.lastIndex = 0;
    const afterCount = (after.match(re) ?? []).length;

    // CSS-exploit markers only appear in `after` (they're the scrub
    // residue); count them straight from there.
    if (kind === 'css-exploit') {
      if (afterCount > 0) {
        details.push({ kind, label, count: afterCount });
      }
      continue;
    }

    if (beforeCount === 0) continue;
    const stripped = beforeCount - afterCount;
    if (stripped > 0) {
      details.push({ kind, label, count: stripped });
    }
  }

  // Generic "content shrunk by a lot" signal as fallback — catches cases
  // where the sanitizer dropped something we didn't pattern-match.
  if (details.length === 0 && before.length - after.length > 50) {
    details.push({
      kind: 'unknown',
      label: 'content removed by sanitizer (specific cause not detected — read the doc back to compare)',
      count: 1,
      bytes: before.length - after.length,
    });
  }

  const messages = details.map((d) =>
    d.bytes !== undefined
      ? `Sanitizer removed ${d.bytes} bytes (${d.label})`
      : `Stripped ${d.count} ${d.label}`,
  );

  return { messages, details };
}

/**
 * Legacy entry point returning just the human-readable strings. Kept so
 * existing call sites don't have to change in lockstep.
 */
export function diffSanitization(before: string, after: string): string[] {
  return diffSanitizationDetails(before, after).messages;
}
