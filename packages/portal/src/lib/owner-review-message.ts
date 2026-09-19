/** Plain-text review summary; the private review page contains the complete values. */
export function ownerReviewMessage(input: { title: string; before: Record<string, unknown>; changes: Record<string, unknown>;
  labels: Record<string, string>; url: string; expiresAt: number }) {
  const display = (value: unknown): string => value == null ? 'Unanswered' : value === true ? 'Yes' : value === false ? 'No'
    : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const shorten = (value: string) => value.length > 2000 ? `${value.slice(0, 2000)}… [continued in review]` : value;
  const summary = Object.entries(input.changes).map(([name, value]) => `${input.labels[name] || name}:\n  Before: ${shorten(display(input.before[name]))}\n  Proposed: ${shorten(display(value))}`).join('\n\n');
  const bounded = summary.length > 16000 ? `${summary.slice(0, 16000)}\n[Summary shortened. Open the private review for all changes.]` : summary;
  return { subject: 'Profile changes awaiting review',
    text: `${input.title}\n\nA verified owner submitted these changes. Nothing has been published.\n\n${bounded}\n\nReview, edit or reject:\n${input.url}\n\nOpening the link does not approve changes. The link expires ${new Date(input.expiresAt).toUTCString()}.` };
}
