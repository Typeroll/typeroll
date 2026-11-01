import { describe, expect, it } from 'vitest';
import { activeHeaderBehavior, isHeaderBehavior, withHeaderBehaviorAttribute, HEADER_BEHAVIOR_CSS, HEADER_BEHAVIOR_RUNTIME_JS } from '../header-behavior.js';

describe('header behaviour', () => {
  it('validates the setting', () => {
    expect(['static', 'sticky', 'reveal_on_scroll_up'].every(isHeaderBehavior)).toBe(true);
    expect(isHeaderBehavior('hide')).toBe(false);
    expect(activeHeaderBehavior(undefined)).toBeNull();
    expect(activeHeaderBehavior('static')).toBeNull();
    expect(activeHeaderBehavior('sticky')).toBe('sticky');
  });

  it('leaves a static header untouched and marks only the first header tag', () => {
    const html = '<header class="hero"><nav></nav></header><header class="x"></header>';
    expect(withHeaderBehaviorAttribute(html, undefined)).toBe(html);
    expect(withHeaderBehaviorAttribute(html, 'static')).toBe(html);
    expect(withHeaderBehaviorAttribute(html, 'reveal_on_scroll_up'))
      .toBe('<header data-header-behavior="reveal_on_scroll_up" class="hero"><nav></nav></header><header class="x"></header>');
    expect(withHeaderBehaviorAttribute('<headers></headers>', 'sticky')).toBe('<headers></headers>');
  });

  it('keeps the compact menu rules in step with the runtime attributes', () => {
    expect(HEADER_BEHAVIOR_CSS).toContain('[data-header-compact]');
    expect(HEADER_BEHAVIOR_RUNTIME_JS).toContain("'data-header-compact'");
    expect(HEADER_BEHAVIOR_RUNTIME_JS).toContain("'data-header-hidden'");
  });
});
