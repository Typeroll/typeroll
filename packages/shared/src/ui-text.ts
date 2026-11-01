/**
 * The few interface words the platform writes itself (control labels,
 * landmarks, the cookie banner defaults) follow the page language. Languages
 * without a translation here fall back to English; a publication reports that
 * so the site can supply its own wording where settings allow it.
 */
export const UI_LANGUAGES = [
  'sv', 'nb', 'da', 'de', 'nl', 'fi', 'fr', 'pl', 'it', 'es', 'pt', 'ru', 'uk', 'cs', 'sk', 'hu', 'ro',
  'bg', 'hr', 'sr', 'bs', 'sl', 'mk', 'sq', 'el', 'lt', 'lv', 'et', 'is', 'tr', 'az', 'kk', 'ka',
  'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'ta', 'th', 'vi', 'id', 'ms', 'ja', 'ko', 'zh', 'zh-Hant', 'ca', 'en',
] as const;
export type UiLanguage = typeof UI_LANGUAGES[number];

/**
 * Tags that share a built-in translation: generic Norwegian `no` reads as
 * Bokmål, and the withdrawn codes `iw` and `in` still name Hebrew and Indonesian.
 */
const UI_LANGUAGE_ALIASES: Readonly<Record<string, UiLanguage>> = { no: 'nb', iw: 'he', in: 'id' };
const PRIMARY_LANGUAGES: ReadonlySet<string> = new Set(UI_LANGUAGES);

/**
 * Built-in interface language for a BCP 47 tag, English when untranslated.
 * Chinese in Traditional script (`zh-Hant`, or Taiwan, Hong Kong and Macao
 * without an explicit `Hans`) reads as `zh-Hant`; other Chinese as Simplified.
 */
export function uiLanguage(language: unknown): UiLanguage {
  const tag = String(language ?? '');
  const primary = /^([a-z]{2,3})\b/i.exec(tag)?.[1]?.toLowerCase() ?? '';
  if (primary === 'zh') {
    const subtags = tag.toLowerCase().split(/[-_]/).slice(1);
    return !subtags.includes('hans') && subtags.some(subtag => ['hant', 'tw', 'hk', 'mo'].includes(subtag)) ? 'zh-Hant' : 'zh';
  }
  if (PRIMARY_LANGUAGES.has(primary)) return primary as UiLanguage;
  return UI_LANGUAGE_ALIASES[primary] ?? 'en';
}

const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi']);
const RTL_SCRIPTS: ReadonlySet<string> = new Set(['adlm', 'arab', 'hebr', 'mand', 'nkoo', 'rohg', 'syrc', 'thaa']);

/**
 * Writing direction of a BCP 47 tag for `<html dir>`. An explicit script
 * subtag decides (`az-Arab` is right-to-left, `ku-Latn` is not); otherwise the
 * language does.
 */
export function languageDirection(language: unknown): 'rtl' | 'ltr' {
  const subtags = String(language ?? '').trim().toLowerCase().split('-');
  const script = subtags.slice(1).find(subtag => /^[a-z]{4}$/.test(subtag));
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL_LANGUAGES.has(subtags[0]) ? 'rtl' : 'ltr';
}

/** True when a language is named but has no built-in translation. */
export function lacksUiTranslation(language: unknown): boolean {
  const tag = String(language ?? '').trim();
  return Boolean(tag) && !/^en\b/i.test(tag) && uiLanguage(tag) === 'en';
}

const UI_TEXT = {
  en: { pagination: 'Pagination', scrollable_table: 'Scrollable table', home: 'Home' },
  sv: { pagination: 'Sidnavigering', scrollable_table: 'Rullbar tabell', home: 'Startsida' },
  de: { pagination: 'Seitennavigation', scrollable_table: 'Scrollbare Tabelle', home: 'Startseite' },
  nl: { pagination: 'Paginering', scrollable_table: 'Scrollbare tabel', home: 'Home' },
  nb: { pagination: 'Sidenavigasjon', scrollable_table: 'Rullbar tabell', home: 'Forside' },
  fi: { pagination: 'Sivunumerointi', scrollable_table: 'Vieritettävä taulukko', home: 'Etusivu' },
  fr: { pagination: 'Pagination', scrollable_table: 'Tableau défilant', home: 'Accueil' },
  pl: { pagination: 'Paginacja', scrollable_table: 'Przewijana tabela', home: 'Strona główna' },
  it: { pagination: 'Paginazione', scrollable_table: 'Tabella scorrevole', home: 'Home' },
  es: { pagination: 'Paginación', scrollable_table: 'Tabla desplazable', home: 'Inicio' },
  da: { pagination: 'Sidenavigation', scrollable_table: 'Rulbar tabel', home: 'Forside' },
  pt: { pagination: 'Paginação', scrollable_table: 'Tabela deslizável', home: 'Início' },
  ru: { pagination: 'Навигация по страницам', scrollable_table: 'Прокручиваемая таблица', home: 'Главная' },
  uk: { pagination: 'Навігація сторінками', scrollable_table: 'Таблиця з прокручуванням', home: 'Головна' },
  cs: { pagination: 'Stránkování', scrollable_table: 'Posuvná tabulka', home: 'Úvod' },
  sk: { pagination: 'Stránkovanie', scrollable_table: 'Posúvateľná tabuľka', home: 'Domov' },
  hu: { pagination: 'Lapozás', scrollable_table: 'Görgethető táblázat', home: 'Főoldal' },
  ro: { pagination: 'Paginare', scrollable_table: 'Tabel derulabil', home: 'Acasă' },
  bg: { pagination: 'Навигация по страници', scrollable_table: 'Таблица с превъртане', home: 'Начало' },
  hr: { pagination: 'Navigacija stranicama', scrollable_table: 'Pomična tablica', home: 'Početna' },
  sr: { pagination: 'Навигација по страницама', scrollable_table: 'Табела са померањем', home: 'Почетна' },
  bs: { pagination: 'Navigacija po stranicama', scrollable_table: 'Tabela s pomicanjem', home: 'Početna' },
  sl: { pagination: 'Navigacija po straneh', scrollable_table: 'Drsna tabela', home: 'Domov' },
  mk: { pagination: 'Навигација низ страници', scrollable_table: 'Табела со лизгање', home: 'Почетна' },
  sq: { pagination: 'Navigimi i faqeve', scrollable_table: 'Tabelë e rrëshqitshme', home: 'Kreu' },
  el: { pagination: 'Σελιδοποίηση', scrollable_table: 'Πίνακας με κύλιση', home: 'Αρχική' },
  lt: { pagination: 'Puslapių naršymas', scrollable_table: 'Slenkama lentelė', home: 'Pradžia' },
  lv: { pagination: 'Lapu navigācija', scrollable_table: 'Ritināma tabula', home: 'Sākums' },
  et: { pagination: 'Lehekülgede navigeerimine', scrollable_table: 'Keritav tabel', home: 'Avaleht' },
  is: { pagination: 'Síðuflakk', scrollable_table: 'Skrunanleg tafla', home: 'Forsíða' },
  tr: { pagination: 'Sayfalama', scrollable_table: 'Kaydırılabilir tablo', home: 'Ana sayfa' },
  az: { pagination: 'Səhifələmə', scrollable_table: 'Sürüşdürülən cədvəl', home: 'Ana səhifə' },
  kk: { pagination: 'Беттер навигациясы', scrollable_table: 'Айналдырылатын кесте', home: 'Басты бет' },
  ka: { pagination: 'გვერდებზე ნავიგაცია', scrollable_table: 'გადახვევადი ცხრილი', home: 'მთავარი' },
  ar: { pagination: 'التنقل بين الصفحات', scrollable_table: 'جدول قابل للتمرير', home: 'الرئيسية' },
  he: { pagination: 'ניווט בין עמודים', scrollable_table: 'טבלה נגללת', home: 'דף הבית' },
  fa: { pagination: 'صفحه‌بندی', scrollable_table: 'جدول قابل پیمایش', home: 'صفحه اصلی' },
  ur: { pagination: 'صفحہ بندی', scrollable_table: 'اسکرول ہونے والا ٹیبل', home: 'ہوم' },
  hi: { pagination: 'पेज नेविगेशन', scrollable_table: 'स्क्रॉल करने योग्य टेबल', home: 'होम' },
  bn: { pagination: 'পৃষ্ঠা নেভিগেশন', scrollable_table: 'স্ক্রলযোগ্য টেবিল', home: 'হোম' },
  ta: { pagination: 'பக்க வழிசெலுத்தல்', scrollable_table: 'உருட்டக்கூடிய அட்டவணை', home: 'முகப்பு' },
  th: { pagination: 'การแบ่งหน้า', scrollable_table: 'ตารางที่เลื่อนได้', home: 'หน้าแรก' },
  vi: { pagination: 'Phân trang', scrollable_table: 'Bảng có thể cuộn', home: 'Trang chủ' },
  id: { pagination: 'Navigasi halaman', scrollable_table: 'Tabel yang dapat digulir', home: 'Beranda' },
  ms: { pagination: 'Penomboran halaman', scrollable_table: 'Jadual boleh tatal', home: 'Laman Utama' },
  ja: { pagination: 'ページ送り', scrollable_table: 'スクロール可能な表', home: 'ホーム' },
  ko: { pagination: '페이지 탐색', scrollable_table: '스크롤 가능한 표', home: '홈' },
  zh: { pagination: '分页', scrollable_table: '可滚动表格', home: '首页' },
  'zh-Hant': { pagination: '分頁', scrollable_table: '可捲動表格', home: '首頁' },
  ca: { pagination: 'Paginació', scrollable_table: 'Taula desplaçable', home: 'Inici' },
} as const satisfies Record<UiLanguage, Record<string, string>>;

export type UiTextKey = keyof typeof UI_TEXT.en;

export function uiText(language: unknown, key: UiTextKey): string {
  return UI_TEXT[uiLanguage(language)][key];
}
