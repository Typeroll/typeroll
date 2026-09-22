/** Plain-text review summary; the private review page contains the complete values. */

/**
 * An answer as a reviewer reads it, not as it is stored.
 *
 * Answers to multi-option questions are objects of booleans, and rendering
 * them with JSON.stringify asked a reviewer to parse `{ "training": true }` to
 * learn that a company offers training. The mail is read first and often on a
 * phone, and may be all someone reads before deciding whether to open the
 * link, so it is the worst place to show storage shape.
 */
export function displayAnswer(value: unknown, depth = 0): string {
  if (value == null) return 'Unanswered';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (typeof value === 'string') return value || 'Blank';
  if (typeof value === 'number') return String(value);
  // Deeper than a reviewer can read as prose. The review page holds the rest.
  if (depth > 2) return '[see review]';
  const indent = '  '.repeat(depth + 1);
  if (Array.isArray(value))
    return value.length ? value.map(item => `\n${indent}- ${displayAnswer(item, depth + 1)}`).join('') : 'None';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // A company asserting no facts, which is different from being unanswered.
    if (!entries.length) return 'None specified';
    return entries
      .map(([key, nested]) => `\n${indent}${humanize(key)}: ${displayAnswer(nested, depth + 1)}`)
      .join('');
  }
  return String(value);
}

/** Option ids are snake_case; a reviewer should not have to read them that way. */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

export function ownerReviewMessage(input: { title: string; before: Record<string, unknown>; changes: Record<string, unknown>;
  labels: Record<string, string>; url: string; expiresAt: number }) {
  const shorten = (value: string) => value.length > 2000 ? `${value.slice(0, 2000)}… [continued in review]` : value;
  // A multi-line answer sits under its own heading, so it indents one level
  // further than the `Before:`/`Proposed:` label it belongs to. Without this
  // the nested lines align with the labels and read as siblings of them.
  const field = (label: string, value: unknown) => {
    const rendered = shorten(displayAnswer(value)).replace(/\n/g, '\n  ');
    return `  ${label}:${rendered.startsWith('\n') ? '' : ' '}${rendered}`;
  };
  const summary = Object.entries(input.changes)
    .map(([name, value]) => `${input.labels[name] || name}:\n${field('Before', input.before[name])}\n${field('Proposed', value)}`)
    .join('\n\n');
  const bounded = summary.length > 16000 ? `${summary.slice(0, 16000)}\n[Summary shortened. Open the private review for all changes.]` : summary;
  return { subject: 'Profile changes awaiting review',
    text: `${input.title}\n\nA verified owner submitted these changes. Nothing has been published.\n\n${bounded}\n\nReview, edit or reject:\n${input.url}\n\nOpening the link does not approve changes. The link expires ${new Date(input.expiresAt).toUTCString()}.` };
}

/**
 * What a reviewer is told once their decision is recorded.
 *
 * Says what happened rather than that something happened: approving is
 * irreversible from the reviewer's side, and their live question at that
 * moment is whether it made the profile public. The review page answers that
 * before they act, so it should not go quiet on it afterwards.
 */
export function reviewOutcomeMessage(status: string, adjustments = 0): string {
  if (status === 'approved')
    return `Approved${adjustments ? ' with your edits' : ''}. The profile now shows these changes, and nothing has been published — publishing is a separate action.`;
  if (status === 'rejected')
    return 'Rejected. The proposed changes were discarded and nothing has been published.';
  return `This proposal is ${status}. Nothing has been published.`;
}
