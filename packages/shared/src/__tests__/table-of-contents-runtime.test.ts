// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
const block = buildCoreBlockRegistry().get('core/table_of_contents')!;
function initialize() {
  let init: (el: Element) => void = () => { throw new Error('Initializer missing'); };
  Object.assign(window, { TyperollBlocks: { register: (_id: string, callback: typeof init) => { init = callback; } } });
  (0, eval)(block.script!);
  init(document.querySelector('nav')!);
}
afterEach(() => { document.body.innerHTML = ''; window.dispatchEvent(new Event('scroll')); vi.restoreAllMocks(); });
it('keeps server-rendered links and changes the active heading on scroll', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { fn(0); return 1; });
  document.body.innerHTML = '<main><nav data-levels="h2"><ol><li><a href="#one">First</a></li><li><a href="#two">Second</a></li></ol></nav><h2 id="one">First</h2><h2 id="two">Second</h2></main>';
  let secondTop = 500;
  vi.spyOn(document.getElementById('one')!, 'getBoundingClientRect').mockImplementation(() => ({ top: 0 }) as DOMRect);
  vi.spyOn(document.getElementById('two')!, 'getBoundingClientRect').mockImplementation(() => ({ top: secondTop }) as DOMRect);
  initialize();
  expect(document.querySelector('[aria-current="location"]')?.getAttribute('href')).toBe('#one');
  secondTop = 40; window.dispatchEvent(new Event('scroll'));
  expect(document.querySelector('[aria-current="location"]')?.getAttribute('href')).toBe('#one');
  secondTop = 16; window.dispatchEvent(new Event('scroll'));
  expect(document.querySelector('[aria-current="location"]')?.getAttribute('href')).toBe('#two');
  expect(document.querySelectorAll('nav a')).toHaveLength(2);
});
it('builds a fallback from current headings at the selected levels without authored items', () => {
  document.body.innerHTML = '<main><nav data-levels="h2" data-highlight-active="false"><ol></ol></nav><h2>Packa glas</h2><h3>Excluded</h3><h2 id="legacy">Second</h2></main>';
  initialize();
  expect([...document.querySelectorAll('nav a')].map(a => a.getAttribute('href'))).toEqual(['#packa-glas', '#legacy']);
  expect(document.querySelector('nav')?.getAttribute('data-empty')).toBe('false');
  expect(document.querySelector('[aria-current]')).toBeNull();
});

it('keeps an empty server outline empty even when the template has its own headings', () => {
  document.body.innerHTML = '<main><nav data-empty="true"><ol></ol></nav><h2>Related articles</h2></main>';
  initialize();
  expect(document.querySelectorAll('nav a')).toHaveLength(0);
  expect(document.querySelector('nav')?.getAttribute('data-empty')).toBe('true');
});
