// Consent-gated core/embed blocks.
//
// A vendor widget pasted into core/embed (an energy comparer, a booking
// widget, a map) often sets cookies or calls home the moment it loads. With
// `consent: "optional"` the block waits for the same answer as
// cookie_consent.scripts_optional:
//
//   - the `html` is emitted inside <template data-tr-consent="optional">, so
//     its iframes, images and other resources stay inert;
//   - a placeholder with a button that reopens the cookie banner is shown
//     next to it;
//   - the block's `js` runs only after the template is stamped out.
//
// The consent runtime (consent-scripts.ts buildConsentRuntime) already
// replaces every such template after optional consent. For a gated embed it
// then removes the placeholder, marks the block `data-tr-consent-embed="active"`
// and dispatches `typeroll:consent-embed` on it, which starts its `js`.
//
// `consent: "none"` (the default) renders exactly what core/embed always did.

import { cookieConsentLanguage, cookieConsentManageLabel, type CookieConsentLanguage } from './cookie-consent.js';
import type { BlockTreeWarning } from './block-tree-warnings.js';

export const CONSENT_EMBED_VALUES = ['none', 'optional'] as const;
export type ConsentEmbedValue = typeof CONSENT_EMBED_VALUES[number];

/** True for a core/embed data object that waits for optional consent. */
export function isConsentGatedEmbed(type: unknown, data: unknown): boolean {
  return type === 'core/embed'
    && !!data && typeof data === 'object'
    && (data as Record<string, unknown>).consent === 'optional';
}

/** The placeholder sentence shown until the visitor accepts all cookies. */
const CONSENT_EMBED_TEXT: Record<CookieConsentLanguage, string> = {
  sv: 'Innehållet visas när du godkänner alla cookies.',
  nb: 'Dette innholdet vises når du godtar alle informasjonskapsler.',
  da: 'Indholdet vises, når du accepterer alle cookies.',
  de: 'Dieser Inhalt wird angezeigt, wenn Sie alle Cookies akzeptieren.',
  nl: 'Deze inhoud wordt getoond als je alle cookies accepteert.',
  fi: 'Tämä sisältö näytetään, kun hyväksyt kaikki evästeet.',
  fr: 'Ce contenu s’affiche lorsque vous acceptez tous les cookies.',
  pl: 'Ta treść pojawi się po zaakceptowaniu wszystkich plików cookie.',
  it: 'Questo contenuto viene mostrato quando accetti tutti i cookie.',
  es: 'Este contenido se muestra cuando aceptas todas las cookies.',
  pt: 'Este conteúdo é exibido quando você aceita todos os cookies.',
  ru: 'Этот контент появится, когда вы примете все файлы cookie.',
  uk: 'Цей вміст з’явиться, коли ви приймете всі файли cookie.',
  cs: 'Tento obsah se zobrazí, když přijmete všechny soubory cookie.',
  sk: 'Tento obsah sa zobrazí, keď prijmete všetky súbory cookie.',
  hu: 'Ez a tartalom akkor jelenik meg, ha elfogadja az összes sütit.',
  ro: 'Acest conținut se afișează după ce acceptați toate cookie-urile.',
  bg: 'Това съдържание се показва, когато приемете всички бисквитки.',
  hr: 'Ovaj se sadržaj prikazuje kada prihvatite sve kolačiće.',
  sr: 'Овај садржај се приказује када прихватите све колачиће.',
  bs: 'Ovaj sadržaj se prikazuje kada prihvatite sve kolačiće.',
  sl: 'Ta vsebina se prikaže, ko sprejmete vse piškotke.',
  mk: 'Оваа содржина се прикажува кога ќе ги прифатите сите колачиња.',
  sq: 'Kjo përmbajtje shfaqet kur pranoni të gjitha cookies.',
  el: 'Αυτό το περιεχόμενο εμφανίζεται όταν αποδεχτείτε όλα τα cookies.',
  lt: 'Šis turinys rodomas, kai priimate visus slapukus.',
  lv: 'Šis saturs tiek parādīts, kad pieņemat visas sīkdatnes.',
  et: 'See sisu kuvatakse, kui nõustute kõigi küpsistega.',
  is: 'Þetta efni birtist þegar þú samþykkir allar vafrakökur.',
  tr: 'Bu içerik, tüm çerezleri kabul ettiğinizde gösterilir.',
  az: 'Bu məzmun bütün kukiləri qəbul etdikdə göstərilir.',
  kk: 'Бұл мазмұн барлық cookie файлдарын қабылдағанда көрсетіледі.',
  ka: 'ეს შინაარსი გამოჩნდება, როცა ყველა ქუქი-ფაილს მიიღებთ.',
  ar: 'يظهر هذا المحتوى عند قبول جميع ملفات تعريف الارتباط.',
  he: 'התוכן הזה יוצג לאחר שתאשרו את כל העוגיות.',
  fa: 'این محتوا پس از پذیرش همه کوکی‌ها نمایش داده می‌شود.',
  ur: 'یہ مواد تمام کوکیز قبول کرنے پر دکھایا جاتا ہے۔',
  hi: 'यह सामग्री सभी कुकी स्वीकार करने पर दिखाई जाती है।',
  bn: 'সব কুকি গ্রহণ করলে এই কনটেন্টটি দেখানো হবে।',
  ta: 'அனைத்து குக்கீகளையும் ஏற்றதும் இந்த உள்ளடக்கம் காட்டப்படும்.',
  th: 'เนื้อหานี้จะแสดงเมื่อคุณยอมรับคุกกี้ทั้งหมด',
  vi: 'Nội dung này sẽ hiển thị khi bạn chấp nhận tất cả cookie.',
  id: 'Konten ini ditampilkan setelah Anda menerima semua cookie.',
  ms: 'Kandungan ini dipaparkan apabila anda menerima semua kuki.',
  ja: 'このコンテンツは、すべてのCookieを許可すると表示されます。',
  ko: '모든 쿠키를 허용하면 이 콘텐츠가 표시됩니다.',
  zh: '接受所有 Cookie 后即可显示此内容。',
  'zh-Hant': '接受所有 Cookie 後即可顯示此內容。',
  ca: 'Aquest contingut es mostra quan accepteu totes les galetes.',
  en: 'This content is shown when you accept all cookies.',
};

/** Built-in placeholder sentence in the page language, otherwise English. */
export function consentEmbedDefaultText(language: unknown): string {
  return CONSENT_EMBED_TEXT[cookieConsentLanguage(language)];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * The inner markup of a gated embed: the authored html as inert template
 * content, then the placeholder. `placeholder` is the block's own text
 * (plain text); blank uses the built-in sentence. The button reopens the
 * banner through the runtime's document-wide `data-tr-open-consent` hook and
 * uses the banner's settings label, the site's `labels.manage` when set.
 */
export function consentEmbedHtml(
  html: string,
  options: { placeholder?: unknown; language?: unknown; consentLabels?: unknown },
): string {
  const custom = typeof options.placeholder === 'string' ? options.placeholder.trim() : '';
  const text = custom || consentEmbedDefaultText(options.language);
  const button = cookieConsentManageLabel(options.language, options.consentLabels);
  return `<template data-tr-consent="optional" data-tr-consent-embed-content>${html}</template>`
    + `<div class="tr-consent-embed" data-tr-consent-placeholder>`
    + `<p class="tr-consent-embed__text">${escapeHtml(text)}</p>`
    + `<button type="button" class="tr-consent-embed__button" data-tr-open-consent>${escapeHtml(button)}</button>`
    + `</div>`;
}

/**
 * Placeholder styles, shipped only on pages with a gated embed. Every
 * selector is wrapped in :where() so any site rule restyles it.
 */
export const CONSENT_EMBED_CSS = ':where(.tr-consent-embed){display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;padding:1.5rem 1rem;border:1px dashed color-mix(in srgb,currentColor 35%,transparent);border-radius:.5rem;text-align:center}'
  + ':where(.tr-consent-embed__text){margin:0}'
  + ':where(.tr-consent-embed__button){font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:.375rem;padding:.5rem 1rem;cursor:pointer}'
  + ':where(.tr-consent-embed__button):focus-visible{outline:2px solid currentColor;outline-offset:2px}';

/**
 * Wrap a gated embed's `js` so it runs after the runtime activated the block:
 * at once when that already happened, otherwise on `typeroll:consent-embed`.
 * `code` is already neutralised against `</script` by the caller.
 */
export function consentEmbedScript(bid: string, code: string): string {
  return `/* instance ${bid} (after consent) */\n(function(){var el=document.querySelector('[data-bid="${bid}"]');if(!el)return;var ran=false;function run(){if(ran)return;ran=true;\n${code}\n}if(el.getAttribute('data-tr-consent-embed')==='active')run();else el.addEventListener('typeroll:consent-embed',run);})();`;
}

const NO_BANNER_MESSAGE = 'This embed waits for cookie consent (consent: "optional"), but the site\'s cookie banner is off, so visitors can never accept and the embed stays a placeholder. Turn on cookie_consent.enabled, or set consent to "none" if the site does not ask for consent.';

/**
 * `consent_embed_without_banner` warnings for gated embeds in a block tree
 * (children and slots included) when the site's cookie banner is off. `root`
 * is the tree's path in the write, e.g. `blocks`.
 */
export function consentEmbedTreeWarnings(value: unknown, bannerEnabled: boolean, root = 'blocks'): BlockTreeWarning[] {
  if (bannerEnabled) return [];
  const warnings: BlockTreeWarning[] = [];
  const visit = (node: unknown, path: string) => {
    if (!Array.isArray(node)) return;
    node.forEach((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return;
      const b = block as { id?: unknown; type?: unknown; data?: unknown; children?: unknown; slots?: unknown };
      const at = `${path}[${index}]`;
      if (isConsentGatedEmbed(b.type, b.data)) warnings.push(consentEmbedWarning(typeof b.id === 'string' ? b.id : undefined, `${at}.data.consent`));
      visit(b.children, `${at}.children`);
      if (Array.isArray(b.slots)) b.slots.forEach((slot, s) => visit(slot, `${at}.slots[${s}]`));
    });
  };
  visit(value, root);
  return warnings;
}

/** The single-block form, for add_block / update_block writes. */
export function consentEmbedBlockWarnings(block: { id?: string; type?: string; data?: Record<string, unknown> }, bannerEnabled: boolean, path = 'block'): BlockTreeWarning[] {
  return !bannerEnabled && isConsentGatedEmbed(block.type, block.data) ? [consentEmbedWarning(block.id, `${path}.data.consent`)] : [];
}

function consentEmbedWarning(blockId: string | undefined, path: string): BlockTreeWarning {
  return { code: 'consent_embed_without_banner', ...(blockId ? { block_id: blockId } : {}), block_type: 'core/embed', path, key: 'consent', message: NO_BANNER_MESSAGE };
}
