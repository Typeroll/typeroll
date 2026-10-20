// Suggestions for a misspelled name: the declared names closest to it.

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Up to three declared names that look like `key`: small edit distance or one containing the other. */
export function closestFieldNames(key: string, names: Iterable<string>): string[] {
  const lower = key.toLowerCase();
  const limit = Math.max(2, Math.floor(lower.length / 3));
  return [...new Set(names)]
    .map(name => {
      const distance = editDistance(lower, name.toLowerCase());
      const contains = lower.length >= 3 && name.length >= 3 && (name.includes(lower) || lower.includes(name));
      return { name, score: distance <= limit ? distance : contains ? limit + 1 : Infinity };
    })
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(candidate => candidate.name);
}
