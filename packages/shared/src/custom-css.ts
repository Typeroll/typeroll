/**
 * Site and page custom CSS: checks for the editors, API and MCP, and safe
 * output into a <style> element.
 *
 * Errors make the stylesheet unusable or unsafe (unbalanced braces, an
 * unclosed comment or string, script-capable constructs). Warnings point at
 * fragile choices, chiefly selectors that target platform markup
 * (`[data-block]`, `.block-*`), which can change between render versions;
 * named styles (`s-<id>`) and block classes are the stable hooks.
 */

export const CUSTOM_CSS_MAX_LENGTH = 100_000;

export interface CustomCssProblem {
  severity: 'error' | 'warning';
  code: 'syntax' | 'unsafe' | 'too_long' | 'platform_selector' | 'import';
  /** 1-based line where the problem starts. */
  line: number;
  message: string;
}

const PLATFORM_SELECTOR = /\[data-(?:block|bid|presentation|source-block)[\w-]*|\.block-[\w-]+/;
const UNSAFE = [
  { pattern: /<\/style/i, message: '"</style" would end the stylesheet early. Remove it.' },
  { pattern: /expression\s*\(/i, message: 'CSS expression() is not allowed.' },
  { pattern: /javascript\s*:/i, message: 'javascript: URLs are not allowed in CSS.' },
  { pattern: /-moz-binding|behavior\s*:/i, message: 'Script bindings (-moz-binding, behavior) are not allowed.' },
];

/** Problems in a custom stylesheet, in source order. Empty for valid CSS without warnings. */
export function checkCustomCss(css: string): CustomCssProblem[] {
  const problems: CustomCssProblem[] = [];
  if (css.length > CUSTOM_CSS_MAX_LENGTH) {
    problems.push({ severity: 'error', code: 'too_long', line: 1, message: `Custom CSS is limited to ${CUSTOM_CSS_MAX_LENGTH.toLocaleString('en')} characters.` });
  }
  const lineAt = (index: number) => css.slice(0, index).split('\n').length;
  for (const { pattern, message } of UNSAFE) {
    const match = pattern.exec(css);
    if (match) problems.push({ severity: 'error', code: 'unsafe', line: lineAt(match.index), message });
  }

  // Walk the stylesheet once, tracking comments, strings and block nesting.
  // A prelude is the text before `{`; inside an at-rule block (or at top
  // level) it is a selector list or a nested at-rule.
  const stack: Array<{ kind: 'at' | 'rule'; line: number }> = [];
  let prelude = '';
  let preludeStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) { problems.push({ severity: 'error', code: 'syntax', line: lineAt(i), message: 'A comment is not closed with */.' }); break; }
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      if (css[j] !== ch) { problems.push({ severity: 'error', code: 'syntax', line: lineAt(i), message: 'A quoted string is not closed on the same line.' }); i = j; continue; }
      if (!stack.length || stack[stack.length - 1].kind === 'at') prelude += css.slice(i, j + 1);
      i = j;
      continue;
    }
    const inSelectorContext = !stack.length || stack[stack.length - 1].kind === 'at';
    if (ch === '{') {
      const text = prelude.trim();
      const isAt = text.startsWith('@');
      if (inSelectorContext && text && !isAt && PLATFORM_SELECTOR.test(text)) {
        problems.push({ severity: 'warning', code: 'platform_selector', line: lineAt(preludeStart), message: `"${text.slice(0, 80)}" targets platform markup that can change between render versions. Use a named style class (s-…) or a CSS class set on the block instead.` });
      }
      if (inSelectorContext && !text) problems.push({ severity: 'error', code: 'syntax', line: lineAt(i), message: 'A rule has no selector before "{".' });
      stack.push({ kind: isAt && /^@(?:media|supports|container|layer|document|scope)\b/i.test(text) ? 'at' : 'rule', line: lineAt(i) });
      prelude = '';
      continue;
    }
    if (ch === '}') {
      if (!stack.length) { problems.push({ severity: 'error', code: 'syntax', line: lineAt(i), message: 'There is a "}" without a matching "{".' }); continue; }
      stack.pop();
      prelude = '';
      continue;
    }
    if (ch === ';' && inSelectorContext) {
      const text = prelude.trim();
      if (/^@import\b/i.test(text)) problems.push({ severity: 'warning', code: 'import', line: lineAt(preludeStart), message: '@import delays the page while another stylesheet loads. Choose web fonts in site settings instead.' });
      else if (text && !text.startsWith('@')) problems.push({ severity: 'error', code: 'syntax', line: lineAt(preludeStart), message: `"${text.slice(0, 60)}" is outside any rule. Put declarations inside a selector's { }.` });
      prelude = '';
      continue;
    }
    if (inSelectorContext) {
      if (!prelude.trim() && ch.trim()) preludeStart = i;
      prelude += ch;
    }
  }
  if (stack.length) problems.push({ severity: 'error', code: 'syntax', line: stack[stack.length - 1].line, message: 'A "{" is not closed with "}".' });
  else if (prelude.trim() && !/^@/.test(prelude.trim())) problems.push({ severity: 'error', code: 'syntax', line: lineAt(preludeStart), message: `"${prelude.trim().slice(0, 60)}" is incomplete: a selector needs { declarations }.` });
  return problems.sort((a, b) => a.line - b.line);
}

/**
 * Stylesheet text that cannot end its <style> element early. Applied on
 * every output path; `<\/style` is an ordinary escape inside CSS.
 */
export function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}
