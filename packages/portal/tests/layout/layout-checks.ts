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
      // Decorative icons are aria-hidden but still take space on the page, so they count.
      && !element.closest('[hidden],.sr-only,.visually-hidden,dialog:not([open]),details:not([open]) > :not(summary)');
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
  const ownText = (element: Element) => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim());
  const textHolders = [...document.querySelectorAll('main :is(span,div,strong,em,small,dt,dd,time,b), header :is(span,div,strong,em,small), footer :is(span,div,strong,em,small)')]
    .filter(element => ownText(element) && !element.closest(LEAF));
  const leaves = [...document.querySelectorAll(`main :is(${LEAF}), header :is(${LEAF}), footer :is(${LEAF})`), ...textHolders].filter(visible)
    .filter(element => !element.parentElement?.closest(LEAF.split(',').filter(tag => tag !== 'li' && tag !== 'td' && tag !== 'th').join(',')));
  const clipToScrollers = (element: Element, box: DOMRect): DOMRect | null => {
    let left = box.left, top = box.top, right = box.right, bottom = box.bottom;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = node.getBoundingClientRect();
      left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
    }
    return right - left > 1 && bottom - top > 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
  };
  const boxes = leaves.flatMap(element => { const clipped = clipToScrollers(element, element.getBoundingClientRect()); return clipped ? [{ element, clipped }] : []; }).map(({ element, clipped }) => ({ element, box: clipped,
    // A wrapped inline element is several line boxes, not the rectangle around them.
    lines: getComputedStyle(element).display.startsWith('inline') && !['img', 'svg', 'video', 'iframe', 'input', 'select', 'textarea', 'button'].includes(element.tagName.toLowerCase())
      ? [...element.getClientRects()].flatMap(line => clipToScrollers(element, line) ?? []) : [clipped] }));
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
    let clipped = false;
    for (let node = element.parentElement; node && node !== parent; node = node.parentElement) if (getComputedStyle(node).overflowX !== 'visible') clipped = true;
    if (clipped) continue;
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

  // 4b. Text never spills out of a painted box (a badge, a pill, a button, a coloured card).
  for (const element of document.querySelectorAll('main *, header *, footer *')) {
    const style = getComputedStyle(element);
    if (!/visible/.test(style.overflowX + style.overflowY) || !visible(element) || !ownText(element)) continue;
    const painted = !/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor) || parseFloat(style.borderTopWidth) > 0;
    if (!painted) continue;
    const spill = Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight);
    if (spill > 2) add('text_spills', element, `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]} spills ${round(spill)}px of text outside its box`);
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

  // 6b. Phones get balanced headings and compact spacing: no heading of a few words per line,
  // no section padding or gap inside a section that leaves a screen half empty.
  if (viewport <= 480) {
    const MIN_CHARS: Record<string, number> = { H1: 14, H2: 16, H3: 18 };
    for (const heading of document.querySelectorAll('main :is(h1,h2,h3)')) {
      if (!visible(heading)) continue;
      const style = getComputedStyle(heading);
      // How many average characters fit on one line (an average glyph is about half the font size wide).
      // Measured on the space the heading can use (its block), not on a heading that shrinks to its text.
      const room = (heading.closest('[data-source-block-type]') ?? heading.parentElement ?? heading).getBoundingClientRect().width;
      const fontSize = parseFloat(style.fontSize), capacity = room / (fontSize * 0.5);
      if (capacity < MIN_CHARS[heading.tagName]!) {
        add('heading_too_large', heading, `${heading.tagName.toLowerCase()} at ${round(fontSize)}px fits about ${round(capacity)} characters per line`);
      }
    }
    for (const section of document.querySelectorAll('main [data-block="section"], main [data-block="hero"]')) {
      if (!visible(section)) continue;
      const style = getComputedStyle(section);
      const padding = Math.max(parseFloat(style.paddingTop), parseFloat(style.paddingBottom));
      if (padding > 56) add('section_padding_mobile', section, `${round(padding)}px vertical padding`);
      const inside = boxes.filter(({ element }) => section.contains(element) && element.closest('[data-block="section"],[data-block="hero"]') === section)
        .sort((a, b) => a.box.top - b.box.top);
      const name = (element: Element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? '.' + element.className.split(' ')[0] : ''} in ${element.closest('[data-block]')?.getAttribute('data-block')}`;
      let last = inside[0];
      for (const item of inside.slice(1)) {
        const card = (element: Element) => { for (let node = element.parentElement; node && node !== section; node = node.parentElement) { const style = getComputedStyle(node); if (!/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor) || style.boxShadow !== 'none' || parseFloat(style.borderTopWidth) > 0) return node; } return null; };
        if (last && card(last.element) !== card(item.element)) { if (item.box.bottom > last.box.bottom) last = item; continue; }
        if (last && Math.round(item.box.top - last.box.bottom) > 48) { add('excess_gap_mobile', section, `${round(item.box.top - last.box.bottom)}px between ${name(last.element)} and ${name(item.element)}`); break; }
        if (!last || item.box.bottom > last.box.bottom) last = item;
      }
    }
  }

  // 6c. A heading inside running text belongs to the text after it: much more space above
  // than below (at least 2.5 times), at every width. Measured on the page, so a Heading block
  // between Text blocks counts the same as a heading inside one Text block.
  const TEXT = 'p,li,blockquote';
  const textBoxes = boxes.filter(({ element }) => element.matches(TEXT));
  for (const heading of document.querySelectorAll('main :is(h2,h3,h4)')) {
    if (!visible(heading) || heading.closest('[data-block="cta"],[data-block="hero"],[data-block="pricing_plan"],[data-block="icon_box"],[data-block="media_card"],[data-block="post_card"],[data-block="team_member"],[data-block="testimonial"],[data-block="step_card"],[data-block="feature_row"],[data-block="accordion"],[data-block="tabs"],header,footer,nav,summary')) continue;
    const group = heading.closest('hgroup') ?? heading, box = group.getBoundingClientRect();
    const section = group.closest('[data-block="section"],main');
    const column = textBoxes.filter(({ element, box: other }) => section?.contains(element) && !group.contains(element)
      && Math.min(other.right, box.right) - Math.max(other.left, box.left) > box.width / 3);
    const before = column.filter(({ box: other }) => other.bottom <= box.top + 1).sort((x, y) => y.box.bottom - x.box.bottom)[0];
    const after = column.filter(({ box: other }) => other.top >= box.bottom - 1).sort((x, y) => x.box.top - y.box.top)[0];
    if (!before || !after) continue;
    const above = box.top - before.box.bottom, below = after.box.top - box.bottom;
    if (above < 2.5 * below) add('heading_spacing', heading, `${heading.tagName.toLowerCase()} has ${round(above)}px above and ${round(below)}px below`);
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
