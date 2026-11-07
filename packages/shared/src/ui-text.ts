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

/**
 * Default labels of block fields (a schema field's `ui_text`). From render
 * version 14 a label left at its English default renders in the page
 * language; an authored label always wins.
 */
const UI_LABELS = {
  en: { learn_more: 'Learn more', get_started: 'Get started', download_pdf: 'Download PDF', menu: 'Menu', open_menu: 'Open menu', close_menu: 'Close menu', search: 'Search…', on_this_page: 'On this page', previous: 'Previous', next: 'Next', continue: 'Continue' },
  sv: { learn_more: 'Läs mer', get_started: 'Kom igång', download_pdf: 'Ladda ner PDF', menu: 'Meny', open_menu: 'Öppna menyn', close_menu: 'Stäng menyn', search: 'Sök…', on_this_page: 'På den här sidan', previous: 'Föregående', next: 'Nästa', continue: 'Fortsätt' },
  nb: { learn_more: 'Les mer', get_started: 'Kom i gang', download_pdf: 'Last ned PDF', menu: 'Meny', open_menu: 'Åpne menyen', close_menu: 'Lukk menyen', search: 'Søk…', on_this_page: 'På denne siden', previous: 'Forrige', next: 'Neste', continue: 'Fortsett' },
  da: { learn_more: 'Læs mere', get_started: 'Kom i gang', download_pdf: 'Download PDF', menu: 'Menu', open_menu: 'Åbn menuen', close_menu: 'Luk menuen', search: 'Søg…', on_this_page: 'På denne side', previous: 'Forrige', next: 'Næste', continue: 'Fortsæt' },
  de: { learn_more: 'Mehr erfahren', get_started: 'Jetzt starten', download_pdf: 'PDF herunterladen', menu: 'Menü', open_menu: 'Menü öffnen', close_menu: 'Menü schließen', search: 'Suchen…', on_this_page: 'Auf dieser Seite', previous: 'Zurück', next: 'Weiter', continue: 'Weiter' },
  nl: { learn_more: 'Meer informatie', get_started: 'Aan de slag', download_pdf: 'PDF downloaden', menu: 'Menu', open_menu: 'Menu openen', close_menu: 'Menu sluiten', search: 'Zoeken…', on_this_page: 'Op deze pagina', previous: 'Vorige', next: 'Volgende', continue: 'Doorgaan' },
  fi: { learn_more: 'Lue lisää', get_started: 'Aloita', download_pdf: 'Lataa PDF', menu: 'Valikko', open_menu: 'Avaa valikko', close_menu: 'Sulje valikko', search: 'Hae…', on_this_page: 'Tällä sivulla', previous: 'Edellinen', next: 'Seuraava', continue: 'Jatka' },
  fr: { learn_more: 'En savoir plus', get_started: 'Commencer', download_pdf: 'Télécharger le PDF', menu: 'Menu', open_menu: 'Ouvrir le menu', close_menu: 'Fermer le menu', search: 'Rechercher…', on_this_page: 'Sur cette page', previous: 'Précédent', next: 'Suivant', continue: 'Continuer' },
  pl: { learn_more: 'Dowiedz się więcej', get_started: 'Zacznij', download_pdf: 'Pobierz PDF', menu: 'Menu', open_menu: 'Otwórz menu', close_menu: 'Zamknij menu', search: 'Szukaj…', on_this_page: 'Na tej stronie', previous: 'Poprzednia', next: 'Następna', continue: 'Dalej' },
  it: { learn_more: 'Scopri di più', get_started: 'Inizia', download_pdf: 'Scarica il PDF', menu: 'Menu', open_menu: 'Apri il menu', close_menu: 'Chiudi il menu', search: 'Cerca…', on_this_page: 'In questa pagina', previous: 'Precedente', next: 'Successivo', continue: 'Continua' },
  es: { learn_more: 'Más información', get_started: 'Empezar', download_pdf: 'Descargar PDF', menu: 'Menú', open_menu: 'Abrir menú', close_menu: 'Cerrar menú', search: 'Buscar…', on_this_page: 'En esta página', previous: 'Anterior', next: 'Siguiente', continue: 'Continuar' },
  pt: { learn_more: 'Saiba mais', get_started: 'Começar', download_pdf: 'Baixar PDF', menu: 'Menu', open_menu: 'Abrir menu', close_menu: 'Fechar menu', search: 'Pesquisar…', on_this_page: 'Nesta página', previous: 'Anterior', next: 'Próximo', continue: 'Continuar' },
  ru: { learn_more: 'Подробнее', get_started: 'Начать', download_pdf: 'Скачать PDF', menu: 'Меню', open_menu: 'Открыть меню', close_menu: 'Закрыть меню', search: 'Поиск…', on_this_page: 'На этой странице', previous: 'Назад', next: 'Далее', continue: 'Продолжить' },
  uk: { learn_more: 'Докладніше', get_started: 'Почати', download_pdf: 'Завантажити PDF', menu: 'Меню', open_menu: 'Відкрити меню', close_menu: 'Закрити меню', search: 'Пошук…', on_this_page: 'На цій сторінці', previous: 'Назад', next: 'Далі', continue: 'Продовжити' },
  cs: { learn_more: 'Více informací', get_started: 'Začít', download_pdf: 'Stáhnout PDF', menu: 'Nabídka', open_menu: 'Otevřít nabídku', close_menu: 'Zavřít nabídku', search: 'Hledat…', on_this_page: 'Na této stránce', previous: 'Předchozí', next: 'Další', continue: 'Pokračovat' },
  sk: { learn_more: 'Viac informácií', get_started: 'Začať', download_pdf: 'Stiahnuť PDF', menu: 'Ponuka', open_menu: 'Otvoriť ponuku', close_menu: 'Zavrieť ponuku', search: 'Hľadať…', on_this_page: 'Na tejto stránke', previous: 'Predchádzajúca', next: 'Ďalšia', continue: 'Pokračovať' },
  hu: { learn_more: 'Tudjon meg többet', get_started: 'Kezdés', download_pdf: 'PDF letöltése', menu: 'Menü', open_menu: 'Menü megnyitása', close_menu: 'Menü bezárása', search: 'Keresés…', on_this_page: 'Ezen az oldalon', previous: 'Előző', next: 'Következő', continue: 'Tovább' },
  ro: { learn_more: 'Află mai multe', get_started: 'Începe', download_pdf: 'Descarcă PDF', menu: 'Meniu', open_menu: 'Deschide meniul', close_menu: 'Închide meniul', search: 'Caută…', on_this_page: 'Pe această pagină', previous: 'Anterior', next: 'Următor', continue: 'Continuă' },
  bg: { learn_more: 'Научете повече', get_started: 'Започнете', download_pdf: 'Изтеглете PDF', menu: 'Меню', open_menu: 'Отваряне на менюто', close_menu: 'Затваряне на менюто', search: 'Търсене…', on_this_page: 'На тази страница', previous: 'Назад', next: 'Напред', continue: 'Продължи' },
  hr: { learn_more: 'Saznajte više', get_started: 'Započnite', download_pdf: 'Preuzmite PDF', menu: 'Izbornik', open_menu: 'Otvori izbornik', close_menu: 'Zatvori izbornik', search: 'Pretraži…', on_this_page: 'Na ovoj stranici', previous: 'Prethodna', next: 'Sljedeća', continue: 'Nastavi' },
  sr: { learn_more: 'Сазнајте више', get_started: 'Започните', download_pdf: 'Преузмите PDF', menu: 'Мени', open_menu: 'Отвори мени', close_menu: 'Затвори мени', search: 'Претрага…', on_this_page: 'На овој страници', previous: 'Претходна', next: 'Следећа', continue: 'Настави' },
  bs: { learn_more: 'Saznajte više', get_started: 'Započnite', download_pdf: 'Preuzmite PDF', menu: 'Meni', open_menu: 'Otvori meni', close_menu: 'Zatvori meni', search: 'Pretraga…', on_this_page: 'Na ovoj stranici', previous: 'Prethodna', next: 'Sljedeća', continue: 'Nastavi' },
  sl: { learn_more: 'Več o tem', get_started: 'Začnite', download_pdf: 'Prenesi PDF', menu: 'Meni', open_menu: 'Odpri meni', close_menu: 'Zapri meni', search: 'Iskanje…', on_this_page: 'Na tej strani', previous: 'Prejšnja', next: 'Naslednja', continue: 'Nadaljuj' },
  mk: { learn_more: 'Дознајте повеќе', get_started: 'Започнете', download_pdf: 'Преземете PDF', menu: 'Мени', open_menu: 'Отвори мени', close_menu: 'Затвори мени', search: 'Пребарување…', on_this_page: 'На оваа страница', previous: 'Претходна', next: 'Следна', continue: 'Продолжи' },
  sq: { learn_more: 'Mësoni më shumë', get_started: 'Filloni', download_pdf: 'Shkarko PDF', menu: 'Menyja', open_menu: 'Hap menynë', close_menu: 'Mbyll menynë', search: 'Kërko…', on_this_page: 'Në këtë faqe', previous: 'E mëparshme', next: 'Tjetra', continue: 'Vazhdo' },
  el: { learn_more: 'Μάθετε περισσότερα', get_started: 'Ξεκινήστε', download_pdf: 'Λήψη PDF', menu: 'Μενού', open_menu: 'Άνοιγμα μενού', close_menu: 'Κλείσιμο μενού', search: 'Αναζήτηση…', on_this_page: 'Σε αυτή τη σελίδα', previous: 'Προηγούμενη', next: 'Επόμενη', continue: 'Συνέχεια' },
  lt: { learn_more: 'Sužinokite daugiau', get_started: 'Pradėkite', download_pdf: 'Atsisiųsti PDF', menu: 'Meniu', open_menu: 'Atidaryti meniu', close_menu: 'Uždaryti meniu', search: 'Ieškoti…', on_this_page: 'Šiame puslapyje', previous: 'Ankstesnis', next: 'Kitas', continue: 'Tęsti' },
  lv: { learn_more: 'Uzzināt vairāk', get_started: 'Sākt', download_pdf: 'Lejupielādēt PDF', menu: 'Izvēlne', open_menu: 'Atvērt izvēlni', close_menu: 'Aizvērt izvēlni', search: 'Meklēt…', on_this_page: 'Šajā lapā', previous: 'Iepriekšējā', next: 'Nākamā', continue: 'Turpināt' },
  et: { learn_more: 'Loe lähemalt', get_started: 'Alusta', download_pdf: 'Laadi PDF alla', menu: 'Menüü', open_menu: 'Ava menüü', close_menu: 'Sulge menüü', search: 'Otsi…', on_this_page: 'Sellel lehel', previous: 'Eelmine', next: 'Järgmine', continue: 'Jätka' },
  is: { learn_more: 'Nánar', get_started: 'Byrja', download_pdf: 'Sækja PDF', menu: 'Valmynd', open_menu: 'Opna valmynd', close_menu: 'Loka valmynd', search: 'Leita…', on_this_page: 'Á þessari síðu', previous: 'Fyrri', next: 'Næsta', continue: 'Áfram' },
  tr: { learn_more: 'Daha fazla bilgi', get_started: 'Başlayın', download_pdf: "PDF'yi indir", menu: 'Menü', open_menu: 'Menüyü aç', close_menu: 'Menüyü kapat', search: 'Ara…', on_this_page: 'Bu sayfada', previous: 'Önceki', next: 'Sonraki', continue: 'Devam' },
  az: { learn_more: 'Ətraflı', get_started: 'Başlayın', download_pdf: 'PDF-i yüklə', menu: 'Menyu', open_menu: 'Menyunu aç', close_menu: 'Menyunu bağla', search: 'Axtar…', on_this_page: 'Bu səhifədə', previous: 'Əvvəlki', next: 'Növbəti', continue: 'Davam et' },
  kk: { learn_more: 'Толығырақ', get_started: 'Бастау', download_pdf: 'PDF жүктеу', menu: 'Мәзір', open_menu: 'Мәзірді ашу', close_menu: 'Мәзірді жабу', search: 'Іздеу…', on_this_page: 'Осы бетте', previous: 'Алдыңғы', next: 'Келесі', continue: 'Жалғастыру' },
  ka: { learn_more: 'გაიგეთ მეტი', get_started: 'დაწყება', download_pdf: 'PDF-ის ჩამოტვირთვა', menu: 'მენიუ', open_menu: 'მენიუს გახსნა', close_menu: 'მენიუს დახურვა', search: 'ძიება…', on_this_page: 'ამ გვერდზე', previous: 'წინა', next: 'შემდეგი', continue: 'გაგრძელება' },
  ar: { learn_more: 'اعرف المزيد', get_started: 'ابدأ الآن', download_pdf: 'تنزيل PDF', menu: 'القائمة', open_menu: 'فتح القائمة', close_menu: 'إغلاق القائمة', search: 'بحث…', on_this_page: 'في هذه الصفحة', previous: 'السابق', next: 'التالي', continue: 'متابعة' },
  he: { learn_more: 'מידע נוסף', get_started: 'להתחיל', download_pdf: 'הורדת PDF', menu: 'תפריט', open_menu: 'פתיחת התפריט', close_menu: 'סגירת התפריט', search: 'חיפוש…', on_this_page: 'בדף זה', previous: 'הקודם', next: 'הבא', continue: 'המשך' },
  fa: { learn_more: 'بیشتر بدانید', get_started: 'شروع کنید', download_pdf: 'دانلود PDF', menu: 'منو', open_menu: 'باز کردن منو', close_menu: 'بستن منو', search: 'جستجو…', on_this_page: 'در این صفحه', previous: 'قبلی', next: 'بعدی', continue: 'ادامه' },
  ur: { learn_more: 'مزید جانیں', get_started: 'شروع کریں', download_pdf: 'PDF ڈاؤن لوڈ کریں', menu: 'مینو', open_menu: 'مینو کھولیں', close_menu: 'مینو بند کریں', search: 'تلاش کریں…', on_this_page: 'اس صفحے پر', previous: 'پچھلا', next: 'اگلا', continue: 'جاری رکھیں' },
  hi: { learn_more: 'और जानें', get_started: 'शुरू करें', download_pdf: 'PDF डाउनलोड करें', menu: 'मेनू', open_menu: 'मेनू खोलें', close_menu: 'मेनू बंद करें', search: 'खोजें…', on_this_page: 'इस पेज पर', previous: 'पिछला', next: 'अगला', continue: 'जारी रखें' },
  bn: { learn_more: 'আরও জানুন', get_started: 'শুরু করুন', download_pdf: 'PDF ডাউনলোড করুন', menu: 'মেনু', open_menu: 'মেনু খুলুন', close_menu: 'মেনু বন্ধ করুন', search: 'অনুসন্ধান…', on_this_page: 'এই পৃষ্ঠায়', previous: 'আগের', next: 'পরের', continue: 'চালিয়ে যান' },
  ta: { learn_more: 'மேலும் அறிக', get_started: 'தொடங்குங்கள்', download_pdf: 'PDF பதிவிறக்கு', menu: 'மெனு', open_menu: 'மெனுவைத் திற', close_menu: 'மெனுவை மூடு', search: 'தேடு…', on_this_page: 'இந்தப் பக்கத்தில்', previous: 'முந்தையது', next: 'அடுத்தது', continue: 'தொடர்க' },
  th: { learn_more: 'ดูเพิ่มเติม', get_started: 'เริ่มต้นใช้งาน', download_pdf: 'ดาวน์โหลด PDF', menu: 'เมนู', open_menu: 'เปิดเมนู', close_menu: 'ปิดเมนู', search: 'ค้นหา…', on_this_page: 'ในหน้านี้', previous: 'ก่อนหน้า', next: 'ถัดไป', continue: 'ดำเนินการต่อ' },
  vi: { learn_more: 'Tìm hiểu thêm', get_started: 'Bắt đầu', download_pdf: 'Tải xuống PDF', menu: 'Menu', open_menu: 'Mở menu', close_menu: 'Đóng menu', search: 'Tìm kiếm…', on_this_page: 'Trên trang này', previous: 'Trước', next: 'Tiếp', continue: 'Tiếp tục' },
  id: { learn_more: 'Selengkapnya', get_started: 'Mulai', download_pdf: 'Unduh PDF', menu: 'Menu', open_menu: 'Buka menu', close_menu: 'Tutup menu', search: 'Cari…', on_this_page: 'Di halaman ini', previous: 'Sebelumnya', next: 'Berikutnya', continue: 'Lanjutkan' },
  ms: { learn_more: 'Ketahui lebih lanjut', get_started: 'Mulakan', download_pdf: 'Muat turun PDF', menu: 'Menu', open_menu: 'Buka menu', close_menu: 'Tutup menu', search: 'Cari…', on_this_page: 'Di halaman ini', previous: 'Sebelumnya', next: 'Seterusnya', continue: 'Teruskan' },
  ja: { learn_more: '詳しく見る', get_started: 'はじめる', download_pdf: 'PDFをダウンロード', menu: 'メニュー', open_menu: 'メニューを開く', close_menu: 'メニューを閉じる', search: '検索…', on_this_page: 'このページの内容', previous: '前へ', next: '次へ', continue: '続ける' },
  ko: { learn_more: '자세히 알아보기', get_started: '시작하기', download_pdf: 'PDF 다운로드', menu: '메뉴', open_menu: '메뉴 열기', close_menu: '메뉴 닫기', search: '검색…', on_this_page: '이 페이지의 내용', previous: '이전', next: '다음', continue: '계속' },
  zh: { learn_more: '了解更多', get_started: '开始使用', download_pdf: '下载 PDF', menu: '菜单', open_menu: '打开菜单', close_menu: '关闭菜单', search: '搜索…', on_this_page: '本页内容', previous: '上一页', next: '下一页', continue: '继续' },
  'zh-Hant': { learn_more: '了解更多', get_started: '開始使用', download_pdf: '下載 PDF', menu: '選單', open_menu: '開啟選單', close_menu: '關閉選單', search: '搜尋…', on_this_page: '本頁內容', previous: '上一頁', next: '下一頁', continue: '繼續' },
  ca: { learn_more: 'Més informació', get_started: 'Comença', download_pdf: 'Baixa el PDF', menu: 'Menú', open_menu: 'Obre el menú', close_menu: 'Tanca el menú', search: 'Cerca…', on_this_page: 'En aquesta pàgina', previous: 'Anterior', next: 'Següent', continue: 'Continua' },
} as const satisfies Record<UiLanguage, Record<string, string>>;

export type UiLabelKey = keyof typeof UI_LABELS.en | 'home';

export function uiLabel(language: unknown, key: UiLabelKey): string {
  return key === 'home' ? uiText(language, 'home') : UI_LABELS[uiLanguage(language)][key];
}

/** The page-language label for a field left unset or at its English default, otherwise the value itself. */
export function localizeDefaultLabel(value: unknown, key: UiLabelKey, language: unknown): unknown {
  return value === undefined || value === uiLabel('en', key) ? uiLabel(language, key) : value;
}


const DEFAULT_DATE_FORMAT = 'MMM D, YYYY';

/**
 * A page or card date for display in the page language. The default format
 * is the language's medium date ("12 okt. 2026", "Oct 12, 2026"); an authored
 * format uses the tokens YYYY, MMMM, MMM, MM, M, DD and D with month names in
 * the page language. A value that is not a date is returned unchanged.
 */
export function formatDisplayDate(value: unknown, language: unknown, format: unknown = DEFAULT_DATE_FORMAT): string {
  const text = String(value ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(text.length === 10 ? `${text}T00:00:00Z` : text) : null;
  if (!date || Number.isNaN(date.getTime())) return text;
  let locale = 'en';
  try { locale = Intl.getCanonicalLocales(String(language ?? '') || 'en')[0] ?? 'en'; } catch { /* an invalid tag reads as English */ }
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(date);
  const pattern = String(format ?? '').trim();
  if (!pattern || pattern === DEFAULT_DATE_FORMAT) return part({ year: 'numeric', month: 'short', day: 'numeric' });
  const day = date.getUTCDate(), month = date.getUTCMonth() + 1;
  return pattern.replace(/YYYY|MMMM|MMM|MM|M|DD|D/g, token => ({
    YYYY: String(date.getUTCFullYear()), MMMM: part({ month: 'long' }), MMM: part({ month: 'short' }),
    MM: String(month).padStart(2, '0'), M: String(month), DD: String(day).padStart(2, '0'), D: String(day),
  })[token]!);
}
