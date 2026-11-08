// Dark surface like the site fields page and the page editor, which the
// shared rich text input is made for. Every text colour keeps at least 4.5:1
// against its background. Raw text: React would escape attribute selectors.
export const SNIPPETS_CSS = `
.snippets {
  display: grid; gap: 1rem; min-width: 0; max-width: 1200px; padding: 1.25rem; border-radius: var(--radius-lg);
  background: #0f0f12; color: #e4e4e7; color-scheme: dark;
  --color-text: #fafafa; --color-text-muted: #c4c4cc; --color-border: #3a3a42; --color-surface: #1f1f23; --color-bg: #18181b;
  --color-primary: #4f46e5; --color-primary-hover: #4338ca; --color-danger: #ef4444;
}
.snippets :where(input:not([type="checkbox"], [type="radio"]), textarea, select) {
  background-color: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; border-radius: 6px; padding: .45rem .6rem; font: inherit; font-size: .9rem; min-width: 0; max-width: 100%;
}
.snippets textarea { width: 100%; min-height: 8rem; line-height: 1.5; resize: vertical; }
.snippets :where(input, textarea)::placeholder { color: #a1a1aa; opacity: 1; }
.snippets :where(button, a, input, select, textarea, [contenteditable]):focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
.snippets a { color: #a5b4fc; }
.snippets code { font-family: var(--font-mono); font-size: .82em; background: #27272a; color: #f4f4f5; padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.snippets .btn--secondary { background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
.snippets .btn--secondary:hover { background: #3f3f46; }
.snippets .btn--ghost { color: #e4e4e7; }
.snippets .btn--ghost:hover { background: #27272a; }
.snippets .btn--sm { min-height: 36px; }
.snippets h1 { font-size: 1.5rem; color: #fafafa; }
.snippets h2 { font-size: 1.05rem; color: #fafafa; }
.snippets h3 { font-size: .95rem; color: #fafafa; }
.sn-header { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem 1rem; flex-wrap: wrap; }
.sn-header__text { display: grid; gap: .25rem; min-width: 0; max-width: 760px; }
.sn-muted { color: #c4c4cc; }
.sn-small { font-size: .82rem; }
.sn-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.sn-card { background: #161618; border: 1px solid #2a2a30; border-radius: 10px; padding: 1rem; min-width: 0; display: grid; gap: .75rem; align-content: start; }
.sn-card--empty { max-width: 760px; }
.sn-notice { display: flex; align-items: flex-start; gap: .5rem; padding: .6rem .85rem; border-radius: 8px; background: #052e16; border: 1px solid #166534; color: #bbf7d0; margin: 0; }
.sn-notice--info { background: #172554; border-color: #1e40af; color: #dbeafe; }
.sn-notice--warn { background: #2a1f0b; border-color: #f59e0b; color: #fde68a; }
.sn-notice svg { flex: none; margin-top: 2px; }
.sn-problem { padding: .75rem 1rem; border-radius: 8px; border: 1px solid #ef4444; background: #2a1215; color: #fecaca; display: grid; gap: .5rem; }
.sn-problem--stale { border-color: #f59e0b; background: #2a1f0b; color: #fde68a; }
.sn-error { color: #fca5a5; font-size: .85rem; margin: 0; }
.sn-errors { margin: 0; padding-left: 1.25rem; color: #fca5a5; font-size: .85rem; }
.sn-badge { display: inline-flex; align-items: center; gap: 4px; font-size: .74rem; padding: 1px 8px; border-radius: 999px; border: 1px solid #52525b; color: #e4e4e7; background: #27272a; white-space: nowrap; }
.sn-badge--live { border-color: #166534; background: #052e16; color: #bbf7d0; }
.sn-badge--later { border-color: #92400e; background: #2a1f0b; color: #fde68a; }
.sn-badge--date { border-color: #1e40af; background: #172554; color: #dbeafe; }
.sn-iconbtn { display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: none; color: #e4e4e7; cursor: pointer; flex: none; }
.sn-iconbtn:hover:not(:disabled) { border-color: #52525b; background: #27272a; }
.sn-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sn-field { display: grid; gap: 4px; min-width: 0; }
.sn-field > label, .sn-label { font-size: .875rem; font-weight: 600; color: #fafafa; }

/* List */
.sn-create { display: grid; gap: .75rem; }
.sn-create__row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-end; }
.sn-create__row .sn-field { flex: 1 1 14rem; }
.sn-kinds { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: .5rem; min-width: 0; }
.sn-kinds legend { padding: 0; margin-bottom: .35rem; font-size: .875rem; font-weight: 600; color: #fafafa; }
.sn-kind { display: grid; grid-template-columns: auto 1fr; gap: 2px .5rem; padding: .6rem .75rem; border: 1px solid #3a3a42; border-radius: 8px; cursor: pointer; }
.sn-kind:has(input:checked) { border-color: #818cf8; background: #1e1b4b; }
.sn-kind input { margin-top: 3px; }
.sn-kind strong { color: #fafafa; font-weight: 600; }
.sn-kind span { grid-column: 2; font-size: .8rem; color: #c4c4cc; }
.sn-table { width: 100%; border-collapse: collapse; }
.sn-table th { text-align: left; padding: .6rem .75rem; font-size: .8rem; font-weight: 500; color: #c4c4cc; border-bottom: 1px solid #3a3a42; }
.sn-table td { padding: .65rem .75rem; vertical-align: top; border-top: 1px solid #2a2a30; font-size: .9rem; }
.sn-table tr:first-child td { border-top: 0; }
.sn-table__name a { font-weight: 600; }
.sn-example { margin: 0; padding: .6rem .85rem; border-left: 3px solid #818cf8; background: #18181b; border-radius: 0 6px 6px 0; display: grid; gap: 2px; }

/* Editor */
.sn-bar { display: flex; align-items: center; justify-content: space-between; gap: .5rem 1rem; flex-wrap: wrap; padding: .6rem .85rem; position: sticky; top: 0; z-index: 3; background: #161618; border: 1px solid #2a2a30; border-radius: 10px; }
.sn-status { font-size: .875rem; color: #c4c4cc; }
.sn-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 360px); gap: 1rem; align-items: start; }
.sn-main, .sn-side { display: grid; gap: 1rem; min-width: 0; }
.sn-side { position: sticky; top: 4.25rem; }
@media (max-width: 1000px) { .sn-grid { grid-template-columns: minmax(0, 1fr); } .sn-side { position: static; } }
.sn-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: .25rem .75rem; flex-wrap: wrap; }
.sn-week { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
.sn-day { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: .5rem .75rem; padding: .6rem; border: 1px solid #2a2a30; border-radius: 8px; align-items: start; }
.sn-day--error { border-color: #ef4444; }
.sn-day__label { display: grid; gap: 2px; padding-top: .35rem; }
.sn-day__label label, .sn-day__label span:first-child { font-weight: 600; color: #fafafa; font-size: .9rem; }
.sn-day__body { display: grid; gap: .35rem; min-width: 0; }
.sn-dates { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
.sn-date { display: grid; grid-template-columns: 11rem minmax(0, 1fr) auto; gap: .5rem .75rem; padding: .6rem; border: 1px solid #2a2a30; border-radius: 8px; align-items: start; }
.sn-date--error { border-color: #ef4444; }
.sn-date input[type="date"] { width: 100%; min-height: 40px; }
.sn-date__errors { grid-column: 1 / -1; }
.sn-preview { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.sn-preview li { display: grid; gap: 2px; padding: .5rem 0; border-top: 1px solid #2a2a30; }
.sn-preview li:first-child { border-top: 0; padding-top: 0; }
.sn-preview__head { display: flex; gap: .5rem; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: .85rem; font-weight: 600; color: #fafafa; }
.sn-preview__content { font-size: .85rem; color: #e4e4e7; white-space: pre-line; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sn-preview__content--empty { color: #a1a1aa; font-style: italic; }
.sn-show { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
.sn-readonly { padding: .6rem .75rem; border: 1px solid #2a2a30; border-radius: 6px; white-space: pre-line; overflow-wrap: anywhere; min-height: 2.5rem; }
.sn-confirm { display: grid; gap: .5rem; padding: .6rem .75rem; border: 1px solid #f59e0b; border-radius: 8px; background: #2a1f0b; color: #fde68a; }
@media (max-width: 640px) {
  .snippets { padding: .85rem; border-radius: 8px; }
  .sn-card { padding: .75rem; }
  .sn-day { grid-template-columns: minmax(0, 1fr); }
  .sn-day__label { padding-top: 0; }
  .sn-date { grid-template-columns: minmax(0, 1fr) auto; }
  .sn-date > .sn-day__body { grid-column: 1 / -1; grid-row: 2; }
  .sn-iconbtn { width: 44px; height: 44px; }
  .sn-bar .btn { flex: 1 1 auto; justify-content: center; }
  .sn-table thead { display: none; }
  .sn-table, .sn-table tbody, .sn-table tr, .sn-table td { display: block; width: 100%; }
  .sn-table tr { padding: .6rem 0; border-top: 1px solid #2a2a30; }
  .sn-table tr:first-child { border-top: 0; }
  .sn-table td { border: 0; padding: .15rem .25rem; }
  .sn-table td[data-label]::before { content: attr(data-label) ": "; color: #c4c4cc; font-size: .78rem; }
}
`;
