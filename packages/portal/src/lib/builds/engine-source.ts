import { createHash } from 'node:crypto';

/**
 * Which build engine code an organization runs. The engine is generated
 * source in the organization's own repository and changes only when someone
 * updates it, so a Core upgrade can leave it behind without anything failing:
 * its builds just lack whatever the newer code adds, such as the readable
 * cause of a failed step. The per-organization `engine.json` is excluded.
 */
export function engineSourceDigest(files: Record<string, string>): string {
  const entries = Object.entries(files).filter(([name]) => name !== 'engine.json').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
