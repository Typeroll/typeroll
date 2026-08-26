// Regression guard for hydration-safe initial render.
//
// Portal components mount with client:load, so React renders them once on the
// server and again on the client, then asserts the two agree. A useState
// initialiser that reads a browser-only API (localStorage, window.location, …)
// breaks that contract: the server takes one branch, the client takes another,
// and React logs
//
//   Warning: Prop `style` did not match. Server: … Client: …
//   Warning: An error occurred during hydration. The server HTML was replaced
//            with client content in <astro-island>.
//
// on every load. That's what BlockPageEditor's `leftTab` did — it seeded itself
// from localStorage, the tab drives inline styles, and anyone whose stored tab
// differed from the SSR default got two console errors per editor load.
//
// The rule: derive initial state from props (or a constant), then apply the
// client-only value in a useEffect after mount.
//
// The check is a source scan: it pulls the argument out of every `useState(…)`
// call in the component tree and fails if a browser global appears inside it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../components');

const BROWSER_GLOBALS = /\b(localStorage|sessionStorage|matchMedia|window|document|navigator)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Returns the source text of each `useState(...)` argument list in `src`,
 * paired with the 1-based line the call starts on. Scans for balanced
 * parens rather than regex-matching the whole call, so multi-line
 * initialisers (the ones most likely to hide a storage read) are covered.
 */
function useStateArgs(src: string): Array<{ line: number; arg: string }> {
  const out: Array<{ line: number; arg: string }> = [];
  // `useState` optionally followed by a type argument, then the open paren.
  const call = /\buseState\s*(<[^(]*?>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      arg: src.slice(open + 1, end),
    });
  }
  return out;
}

describe('SSR-safe initial state', () => {
  // Guards the guard: the exact shape this test was written for.
  it('detects a storage read inside a lazy initialiser', () => {
    const bad = `
      const [leftTab, setLeftTab] = useState<LeftTab>(() => {
        if (typeof window === 'undefined') return 'structure';
        const stored = window.localStorage.getItem('typeroll.block-editor.left-tab');
        if (stored === 'add' || stored === 'structure') return stored;
        return (page.blocks?.length ?? 0) > 0 ? 'structure' : 'add';
      });
    `;
    const args = useStateArgs(bad);
    expect(args).toHaveLength(1);
    expect(BROWSER_GLOBALS.test(args[0].arg)).toBe(true);
  });

  it('no component seeds useState from a browser-only global', () => {
    const offences: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const { line, arg } of useStateArgs(src)) {
        if (BROWSER_GLOBALS.test(arg)) {
          offences.push(
            `${path.relative(ROOT, file)}:${line}  useState(${arg.trim().slice(0, 80)}…)`,
          );
        }
      }
    }
    expect(
      offences,
      `Initial state must not depend on the browser — derive it from props and ` +
        `apply the client-only value in a useEffect after mount:\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
