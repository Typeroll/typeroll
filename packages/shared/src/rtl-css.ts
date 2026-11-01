// Right-to-left mirror of the platform's built-in layout.
//
// Block and template CSS uses physical sides (margin-left, left: …) and is
// frozen per render version, so left-to-right output never changes. Pages
// whose language is written right to left (`languageDirection`) get
// `<html dir="rtl">` and this stylesheet, which swaps those sides. Sides an
// editor chooses (image or divider alignment, caption alignment) are kept.

export const RTL_CSS = `
[dir="rtl"] :where(.page-content) ul, [dir="rtl"] :where(.page-content) ol { padding-left: 0; padding-right: 1.5rem; }
[dir="rtl"] :where(.page-content) blockquote { border-left: 0; border-right: 3px solid var(--color-accent); padding-left: 0; padding-right: var(--spacing-md); }
[dir="rtl"] [data-block="testimonial"] .block-testimonial-logo { margin-left: 0; margin-right: auto; }
[dir="rtl"] [data-block="team_member"][data-layout="overlay"] .block-team-body { text-align: right; }
[dir="rtl"] [data-block="feature_row"] .block-frow-media img { margin-left: 0; margin-right: auto; }
[dir="rtl"] [data-block="feature_row"] .block-frow-body { margin-right: 0; margin-left: auto; }
[dir="rtl"] [data-block="feature_row"][data-image-side="right"] .block-frow-media img { margin-right: 0; margin-left: auto; }
[dir="rtl"] [data-block="feature_row"][data-image-side="right"] .block-frow-body { margin-left: 0; margin-right: auto; }
[dir="rtl"] [data-block="table_of_contents"] ol { padding-left: 0; padding-right: 1.25rem; }
[dir="rtl"] [data-block="table_of_contents"]:is([data-list-style="plain"], [data-list-style="chevron"]) ol { padding-right: 0; }
[dir="rtl"] [data-block="table_of_contents"][data-indent="false"] li { margin-right: 0; }
[dir="rtl"] [data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="3"] { margin-left: 0; margin-right: 1rem; }
[dir="rtl"] [data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="4"] { margin-left: 0; margin-right: 2rem; }
[dir="rtl"] [data-block="table_of_contents"][data-list-style="chevron"] li::before { left: auto; right: 0; transform: rotate(-135deg); }
[dir="rtl"] [data-block="hero"] > .block-hero-video-toggle { right: auto; left: 1rem; }
[dir="rtl"] [data-block="form_toggle"] .form-toggle-track::after { left: auto; right: 0.15rem; }
[dir="rtl"] [data-block="form_toggle"] input:checked + .form-toggle-track::after { transform: translateX(-1.05rem); }
[dir="rtl"] [data-block="form_slider"] .form-slider-value { margin-left: 0; margin-right: 0.4rem; }
[dir="rtl"] [data-block="page_navigation"] .page-navigation-next { margin-left: 0; margin-right: auto; text-align: left; }
@media (max-width: 540px) { [dir="rtl"] [data-block="page_navigation"] .page-navigation-next { margin-right: 0; } }
[dir="rtl"] [data-block="breadcrumbs"][data-sep="arrow"] li:not(:last-child)::after { content: " ← "; }
[dir="rtl"] [data-block="field_list"] ul { padding-left: 0; padding-right: 1.25em; }
[dir="rtl"] [data-block="repeater"] .tr-carousel-button:is([data-carousel-prev], [data-carousel-next]) svg { transform: scaleX(-1); }
[dir="rtl"] .tr-consent__manage { left: auto; right: 1rem; }
`.trim();

/** The mirror stylesheet for a page, empty for left-to-right languages. */
export function directionCss(direction: 'rtl' | 'ltr'): string {
  return direction === 'rtl' ? RTL_CSS : '';
}
