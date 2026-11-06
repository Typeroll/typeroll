/**
 * Layout rules every published page must meet at every width. Runs inside the
 * page (page.evaluate), so it measures the real cascade. Returns problems with
 * a stable key: check, the block it belongs to and a short description.
 */
export interface LayoutProblem { check: string; block: string; detail: string }

export function measureLayout(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const viewport = document.documentElement.clientWidth;
  const add = (check: string, element: Element | null, detail: string) => {
    const owner = element?.closest('[data-source-block-type]');
    const block = owner ? `${owner.getAttribute('data-source-block-type')}#${owner.getAttribute('data-source-block-id')}` : element?.closest('header,footer,main')?.tagName.toLowerCase() ?? 'page';
    problems.push({ check, block, detail });
  };
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && Number(style.opacity) > 0.05
      && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && !element.closest('[hidden],[aria-hidden="true"],.sr-only,.visually-hidden,dialog:not([open]),details:not([open]) > :not(summary)');
  };
  const round = (value: number) => Math.round(value);

  // 1. Nothing is wider than the screen.
  if (document.documentElement.scrollWidth > viewport + 1) {
    const widest = [...document.querySelectorAll('body *')].filter(visible)
      .filter(element => element.getBoundingClientRect().right > viewport + 1 && !element.closest('[data-scroll-x],pre,table,.block-table-scroll'))
      .filter((element, _, all) => !all.some(other => other !== element && element.contains(other)));
    for (const element of widest.slice(0, 5)) add('horizontal_overflow', element, `${element.tagName.toLowerCase()} ends at ${round(element.getBoundingClientRect().right)}px of ${viewport}px`);
    if (!widest.length) add('horizontal_overflow', null, `page is ${document.documentElement.scrollWidth}px wide at ${viewport}px`);
  }

  // 2. Content boxes of different blocks never overlap.
  const LEAF = 'p,h1,h2,h3,h4,h5,h6,li,a,button,input,select,textarea,img,video,iframe,picture,figcaption,blockquote,label,td,th,svg';
  const leaves = [...document.querySelectorAll(`main :is(${LEAF}), header :is(${LEAF}), footer :is(${LEAF})`)].filter(visible)
    .filter(element => !element.parentElement?.closest(LEAF.split(',').filter(tag => tag !== 'li' && tag !== 'td' && tag !== 'th').join(',')));
  const boxes = leaves.map(element => ({ element, box: element.getBoundingClientRect(),
    // A wrapped inline element is several line boxes, not the rectangle around them.
    lines: getComputedStyle(element).display.startsWith('inline') && !['img', 'svg', 'video', 'iframe', 'input', 'select', 'textarea', 'button'].includes(element.tagName.toLowerCase())
      ? [...element.getClientRects()] : [element.getBoundingClientRect()] }));
  const overlap = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const linesOverlap = (a: DOMRect[], b: DOMRect[]) => a.reduce((sum, x) => sum + b.reduce((inner, y) => inner + overlap(x, y), 0), 0);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
    const area = linesOverlap(a.lines, b.lines);
    if (area > 16) add('content_overlap', a.element, `${a.element.tagName.toLowerCase()} overlaps ${b.element.tagName.toLowerCase()} by ${round(area)}px²`);
  }

  // 2b. A block stays inside the block that contains it (a grid cell, a column, a card).
  for (const element of document.querySelectorAll('[data-source-block-type]')) {
    const parent = element.parentElement?.closest('[data-source-block-type]');
    if (!parent || !visible(element) || !visible(parent) || /visible/.test(getComputedStyle(parent).overflowX) === false) continue;
    const inner = element.getBoundingClientRect(), outer = parent.getBoundingClientRect();
    const escape = Math.max(inner.right - outer.right, outer.left - inner.left);
    if (escape > 2) add('escapes_container', element, `${round(escape)}px outside ${parent.getAttribute('data-source-block-type')}`);
  }

  // 3. A painted, absolutely positioned decoration (including ::before/::after) never covers content.
  const painted = (style: CSSStyleDeclaration) => style.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor);
  const decorations: { owner: Element; box: { left: number; top: number; right: number; bottom: number }; label: string }[] = [];
  for (const element of document.querySelectorAll('main *, footer *, header *')) {
    const rect = element.getBoundingClientRect();
    for (const pseudo of ['::before', '::after'] as const) {
      const style = getComputedStyle(element, pseudo);
      if (style.content === 'none' || style.content === 'normal' || !['absolute', 'fixed'].includes(style.position) || !painted(style)) continue;
      const width = parseFloat(style.width), height = parseFloat(style.height);
      if (!(width * height > 64)) continue;
      const left = rect.left + parseFloat(getComputedStyle(element).borderLeftWidth) + (parseFloat(style.left) || 0);
      const top = rect.top + parseFloat(getComputedStyle(element).borderTopWidth) + (parseFloat(style.top) || 0);
      decorations.push({ owner: element, box: { left, top, right: left + width, bottom: top + height }, label: pseudo });
    }
    const style = getComputedStyle(element);
    if (['absolute', 'fixed'].includes(style.position) && painted(style) && !element.querySelector(LEAF) && !element.matches(LEAF) && visible(element)) {
      decorations.push({ owner: element, box: rect, label: element.tagName.toLowerCase() });
    }
  }
  // A form control's padding is where icons belong; only its text area counts.
  const contentBox = (element: Element, box: DOMRect) => {
    if (!element.matches('input,select,textarea')) return box;
    const style = getComputedStyle(element), px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
    const left = box.left + px('border-left-width') + px('padding-left'), right = box.right - px('border-right-width') - px('padding-right');
    const top = box.top + px('border-top-width') + px('padding-top'), bottom = box.bottom - px('border-bottom-width') - px('padding-bottom');
    return { left, right, top, bottom } as DOMRect;
  };
  for (const decoration of decorations) for (const { element, box } of boxes) {
    if (decoration.owner.contains(element) && decoration.label !== '::before' && decoration.label !== '::after') continue;
    const area = overlap(decoration.box as DOMRect, contentBox(element, box));
    if (area > 16) add('decoration_covers_content', element, `${decoration.label} of ${decoration.owner.tagName.toLowerCase()} covers ${element.tagName.toLowerCase()} by ${round(area)}px²`);
  }

  // 4. Text is never cut off by a box that hides overflow.
  for (const element of document.querySelectorAll('main *, header *, footer *')) {
    const style = getComputedStyle(element);
    if (!/hidden|clip/.test(style.overflowX + style.overflowY) || !visible(element) || style.webkitLineClamp !== 'none' || style.textOverflow === 'ellipsis') continue;
    if (!element.textContent?.trim() || element.closest('.sr-only,.visually-hidden')) continue;
    if (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2) {
      add('clipped_text', element, `${element.tagName.toLowerCase()} hides ${Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight)}px of its content`);
    }
  }

  // 5. Touch targets are at least 24 × 24 px (WCAG 2.2 AA), except links inside running text.
  for (const element of document.querySelectorAll('main :is(a,button,input,select,textarea,[role="button"]), header :is(a,button,input,select,[role="button"]), footer :is(a,button,input,select,[role="button"])')) {
    if (!visible(element) || (element as HTMLInputElement).type === 'hidden') continue;
    if (element.matches('a') && element.parentElement?.closest('p,li,td,figcaption,blockquote,label') && element.parentElement.textContent!.trim() !== element.textContent!.trim()) continue;
    const box = element.getBoundingClientRect();
    if (Math.min(box.width, box.height) < 24) add('small_touch_target', element, `${element.tagName.toLowerCase()} is ${round(box.width)}×${round(box.height)}px`);
  }

  // 6. Space between the last content and the footer, unless main ends with a coloured section.
  const main = document.querySelector('main'), footer = document.querySelector('footer');
  if (main && footer) {
    const mainLeaves = boxes.filter(({ element }) => main.contains(element));
    const last = mainLeaves.reduce<typeof mainLeaves[number] | null>((found, item) => !found || item.box.bottom > found.box.bottom ? item : found, null);
    const lastSection = [...main.children].at(-1);
    const background = lastSection ? getComputedStyle(lastSection).backgroundColor : '';
    const bodyBackground = getComputedStyle(document.body).backgroundColor;
    const coloured = !!lastSection && !/rgba\(0, 0, 0, 0\)|transparent/.test(background) && background !== bodyBackground;
    const footerTop = footer.getBoundingClientRect().top;
    if (last && !coloured && footerTop - last.box.bottom < 24) add('footer_space', last.element, `${round(footerTop - last.box.bottom)}px between the last content and the footer`);
  }

  // 7. Text is readable on the background it is actually drawn on (WCAG 2 ratio of at least 3;
  // the platform's APCA checks cover styles, this catches defaults that leave text unreadable).
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const luminance = ([r, g, b]: number[]) => [r!, g!, b!].map(c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  for (const { element } of boxes) {
    if (!element.textContent?.trim() || element.matches('img,svg,video,iframe,picture')) continue;
    let backdrop: string | null = null;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') { backdrop = null; break; }
      const colour = rgb(style.backgroundColor);
      if (colour.length >= 3 && (colour[3] ?? 1) > 0.5) { backdrop = style.backgroundColor; break; }
      if (node === document.documentElement) backdrop = 'rgb(255, 255, 255)';
    }
    if (!backdrop) continue;
    const text = rgb(getComputedStyle(element).color);
    const [a, b] = [luminance(text), luminance(rgb(backdrop))].sort((x, y) => y - x);
    const ratio = (a! + 0.05) / (b! + 0.05);
    if (ratio < 3) add('unreadable_text', element, `${element.tagName.toLowerCase()} ${getComputedStyle(element).color} on ${backdrop} (${ratio.toFixed(2)}:1)`);
  }
  return problems;
}
