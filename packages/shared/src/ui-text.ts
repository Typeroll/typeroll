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
  en: { pagination: 'Pagination', scrollable_table: 'Scrollable table', home: 'Home', show_submenu: 'Show submenu: {label}' },
  sv: { pagination: 'Sidnavigering', scrollable_table: 'Rullbar tabell', home: 'Startsida', show_submenu: 'Visa undermeny: {label}' },
  de: { pagination: 'Seitennavigation', scrollable_table: 'Scrollbare Tabelle', home: 'Startseite', show_submenu: 'Untermenü anzeigen: {label}' },
  nl: { pagination: 'Paginering', scrollable_table: 'Scrollbare tabel', home: 'Home', show_submenu: 'Submenu tonen: {label}' },
  nb: { pagination: 'Sidenavigasjon', scrollable_table: 'Rullbar tabell', home: 'Forside', show_submenu: 'Vis undermeny: {label}' },
  fi: { pagination: 'Sivunumerointi', scrollable_table: 'Vieritettävä taulukko', home: 'Etusivu', show_submenu: 'Näytä alavalikko: {label}' },
  fr: { pagination: 'Pagination', scrollable_table: 'Tableau défilant', home: 'Accueil', show_submenu: 'Afficher le sous-menu : {label}' },
  pl: { pagination: 'Paginacja', scrollable_table: 'Przewijana tabela', home: 'Strona główna', show_submenu: 'Pokaż podmenu: {label}' },
  it: { pagination: 'Paginazione', scrollable_table: 'Tabella scorrevole', home: 'Home', show_submenu: 'Mostra sottomenu: {label}' },
  es: { pagination: 'Paginación', scrollable_table: 'Tabla desplazable', home: 'Inicio', show_submenu: 'Mostrar submenú: {label}' },
  da: { pagination: 'Sidenavigation', scrollable_table: 'Rulbar tabel', home: 'Forside', show_submenu: 'Vis undermenu: {label}' },
  pt: { pagination: 'Paginação', scrollable_table: 'Tabela deslizável', home: 'Início', show_submenu: 'Mostrar submenu: {label}' },
  ru: { pagination: 'Навигация по страницам', scrollable_table: 'Прокручиваемая таблица', home: 'Главная', show_submenu: 'Показать подменю: {label}' },
  uk: { pagination: 'Навігація сторінками', scrollable_table: 'Таблиця з прокручуванням', home: 'Головна', show_submenu: 'Показати підменю: {label}' },
  cs: { pagination: 'Stránkování', scrollable_table: 'Posuvná tabulka', home: 'Úvod', show_submenu: 'Zobrazit podnabídku: {label}' },
  sk: { pagination: 'Stránkovanie', scrollable_table: 'Posúvateľná tabuľka', home: 'Domov', show_submenu: 'Zobraziť podponuku: {label}' },
  hu: { pagination: 'Lapozás', scrollable_table: 'Görgethető táblázat', home: 'Főoldal', show_submenu: 'Almenü megjelenítése: {label}' },
  ro: { pagination: 'Paginare', scrollable_table: 'Tabel derulabil', home: 'Acasă', show_submenu: 'Afișează submeniul: {label}' },
  bg: { pagination: 'Навигация по страници', scrollable_table: 'Таблица с превъртане', home: 'Начало', show_submenu: 'Покажи подменюто: {label}' },
  hr: { pagination: 'Navigacija stranicama', scrollable_table: 'Pomična tablica', home: 'Početna', show_submenu: 'Prikaži podizbornik: {label}' },
  sr: { pagination: 'Навигација по страницама', scrollable_table: 'Табела са померањем', home: 'Почетна', show_submenu: 'Прикажи подмени: {label}' },
  bs: { pagination: 'Navigacija po stranicama', scrollable_table: 'Tabela s pomicanjem', home: 'Početna', show_submenu: 'Prikaži podmeni: {label}' },
  sl: { pagination: 'Navigacija po straneh', scrollable_table: 'Drsna tabela', home: 'Domov', show_submenu: 'Pokaži podmeni: {label}' },
  mk: { pagination: 'Навигација низ страници', scrollable_table: 'Табела со лизгање', home: 'Почетна', show_submenu: 'Прикажи подмени: {label}' },
  sq: { pagination: 'Navigimi i faqeve', scrollable_table: 'Tabelë e rrëshqitshme', home: 'Kreu', show_submenu: 'Shfaq nënmenynë: {label}' },
  el: { pagination: 'Σελιδοποίηση', scrollable_table: 'Πίνακας με κύλιση', home: 'Αρχική', show_submenu: 'Εμφάνιση υπομενού: {label}' },
  lt: { pagination: 'Puslapių naršymas', scrollable_table: 'Slenkama lentelė', home: 'Pradžia', show_submenu: 'Rodyti submeniu: {label}' },
  lv: { pagination: 'Lapu navigācija', scrollable_table: 'Ritināma tabula', home: 'Sākums', show_submenu: 'Rādīt apakšizvēlni: {label}' },
  et: { pagination: 'Lehekülgede navigeerimine', scrollable_table: 'Keritav tabel', home: 'Avaleht', show_submenu: 'Näita alammenüüd: {label}' },
  is: { pagination: 'Síðuflakk', scrollable_table: 'Skrunanleg tafla', home: 'Forsíða', show_submenu: 'Sýna undirvalmynd: {label}' },
  tr: { pagination: 'Sayfalama', scrollable_table: 'Kaydırılabilir tablo', home: 'Ana sayfa', show_submenu: 'Alt menüyü göster: {label}' },
  az: { pagination: 'Səhifələmə', scrollable_table: 'Sürüşdürülən cədvəl', home: 'Ana səhifə', show_submenu: 'Alt menyunu göstər: {label}' },
  kk: { pagination: 'Беттер навигациясы', scrollable_table: 'Айналдырылатын кесте', home: 'Басты бет', show_submenu: 'Ішкі мәзірді көрсету: {label}' },
  ka: { pagination: 'გვერდებზე ნავიგაცია', scrollable_table: 'გადახვევადი ცხრილი', home: 'მთავარი', show_submenu: 'ქვემენიუს ჩვენება: {label}' },
  ar: { pagination: 'التنقل بين الصفحات', scrollable_table: 'جدول قابل للتمرير', home: 'الرئيسية', show_submenu: 'إظهار القائمة الفرعية: {label}' },
  he: { pagination: 'ניווט בין עמודים', scrollable_table: 'טבלה נגללת', home: 'דף הבית', show_submenu: 'הצגת תפריט משנה: {label}' },
  fa: { pagination: 'صفحه‌بندی', scrollable_table: 'جدول قابل پیمایش', home: 'صفحه اصلی', show_submenu: 'نمایش زیرمنو: {label}' },
  ur: { pagination: 'صفحہ بندی', scrollable_table: 'اسکرول ہونے والا ٹیبل', home: 'ہوم', show_submenu: 'ذیلی مینو دکھائیں: {label}' },
  hi: { pagination: 'पेज नेविगेशन', scrollable_table: 'स्क्रॉल करने योग्य टेबल', home: 'होम', show_submenu: 'उप-मेनू दिखाएँ: {label}' },
  bn: { pagination: 'পৃষ্ঠা নেভিগেশন', scrollable_table: 'স্ক্রলযোগ্য টেবিল', home: 'হোম', show_submenu: 'সাবমেনু দেখান: {label}' },
  ta: { pagination: 'பக்க வழிசெலுத்தல்', scrollable_table: 'உருட்டக்கூடிய அட்டவணை', home: 'முகப்பு', show_submenu: 'துணை மெனுவைக் காட்டு: {label}' },
  th: { pagination: 'การแบ่งหน้า', scrollable_table: 'ตารางที่เลื่อนได้', home: 'หน้าแรก', show_submenu: 'แสดงเมนูย่อย: {label}' },
  vi: { pagination: 'Phân trang', scrollable_table: 'Bảng có thể cuộn', home: 'Trang chủ', show_submenu: 'Hiện menu con: {label}' },
  id: { pagination: 'Navigasi halaman', scrollable_table: 'Tabel yang dapat digulir', home: 'Beranda', show_submenu: 'Tampilkan submenu: {label}' },
  ms: { pagination: 'Penomboran halaman', scrollable_table: 'Jadual boleh tatal', home: 'Laman Utama', show_submenu: 'Tunjukkan submenu: {label}' },
  ja: { pagination: 'ページ送り', scrollable_table: 'スクロール可能な表', home: 'ホーム', show_submenu: 'サブメニューを表示: {label}' },
  ko: { pagination: '페이지 탐색', scrollable_table: '스크롤 가능한 표', home: '홈', show_submenu: '하위 메뉴 표시: {label}' },
  zh: { pagination: '分页', scrollable_table: '可滚动表格', home: '首页', show_submenu: '显示子菜单：{label}' },
  'zh-Hant': { pagination: '分頁', scrollable_table: '可捲動表格', home: '首頁', show_submenu: '顯示子選單：{label}' },
  ca: { pagination: 'Paginació', scrollable_table: 'Taula desplaçable', home: 'Inici', show_submenu: 'Mostra el submenú: {label}' },
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
  en: { learn_more: 'Learn more', get_started: 'Get started', download_pdf: 'Download PDF', menu: 'Menu', open_menu: 'Open menu', close_menu: 'Close menu', search: 'Search…', on_this_page: 'On this page', previous: 'Previous', next: 'Next', continue: 'Continue', close: 'Close', enlarge_image: 'Show larger', before: 'Before', after: 'After', pause_animation: 'Pause animation', play_animation: 'Play animation', transcript: 'Transcript', announcement: 'Announcement' },
  sv: { learn_more: 'Läs mer', get_started: 'Kom igång', download_pdf: 'Ladda ner PDF', menu: 'Meny', open_menu: 'Öppna menyn', close_menu: 'Stäng menyn', search: 'Sök…', on_this_page: 'På den här sidan', previous: 'Föregående', next: 'Nästa', continue: 'Fortsätt', close: 'Stäng', enlarge_image: 'Visa större', before: 'Före', after: 'Efter', pause_animation: 'Pausa animationen', play_animation: 'Spela animationen', transcript: 'Utskrift', announcement: 'Meddelande' },
  nb: { learn_more: 'Les mer', get_started: 'Kom i gang', download_pdf: 'Last ned PDF', menu: 'Meny', open_menu: 'Åpne menyen', close_menu: 'Lukk menyen', search: 'Søk…', on_this_page: 'På denne siden', previous: 'Forrige', next: 'Neste', continue: 'Fortsett', close: 'Lukk', enlarge_image: 'Vis større', before: 'Før', after: 'Etter', pause_animation: 'Sett animasjonen på pause', play_animation: 'Spill av animasjonen', transcript: 'Transkripsjon', announcement: 'Kunngjøring' },
  da: { learn_more: 'Læs mere', get_started: 'Kom i gang', download_pdf: 'Download PDF', menu: 'Menu', open_menu: 'Åbn menuen', close_menu: 'Luk menuen', search: 'Søg…', on_this_page: 'På denne side', previous: 'Forrige', next: 'Næste', continue: 'Fortsæt', close: 'Luk', enlarge_image: 'Vis større', before: 'Før', after: 'Efter', pause_animation: 'Sæt animationen på pause', play_animation: 'Afspil animationen', transcript: 'Udskrift', announcement: 'Meddelelse' },
  de: { learn_more: 'Mehr erfahren', get_started: 'Jetzt starten', download_pdf: 'PDF herunterladen', menu: 'Menü', open_menu: 'Menü öffnen', close_menu: 'Menü schließen', search: 'Suchen…', on_this_page: 'Auf dieser Seite', previous: 'Zurück', next: 'Weiter', continue: 'Weiter', close: 'Schließen', enlarge_image: 'Größer anzeigen', before: 'Vorher', after: 'Nachher', pause_animation: 'Animation pausieren', play_animation: 'Animation abspielen', transcript: 'Transkript', announcement: 'Hinweis' },
  nl: { learn_more: 'Meer informatie', get_started: 'Aan de slag', download_pdf: 'PDF downloaden', menu: 'Menu', open_menu: 'Menu openen', close_menu: 'Menu sluiten', search: 'Zoeken…', on_this_page: 'Op deze pagina', previous: 'Vorige', next: 'Volgende', continue: 'Doorgaan', close: 'Sluiten', enlarge_image: 'Groter weergeven', before: 'Voor', after: 'Na', pause_animation: 'Animatie pauzeren', play_animation: 'Animatie afspelen', transcript: 'Transcript', announcement: 'Mededeling' },
  fi: { learn_more: 'Lue lisää', get_started: 'Aloita', download_pdf: 'Lataa PDF', menu: 'Valikko', open_menu: 'Avaa valikko', close_menu: 'Sulje valikko', search: 'Hae…', on_this_page: 'Tällä sivulla', previous: 'Edellinen', next: 'Seuraava', continue: 'Jatka', close: 'Sulje', enlarge_image: 'Näytä suurempana', before: 'Ennen', after: 'Jälkeen', pause_animation: 'Keskeytä animaatio', play_animation: 'Toista animaatio', transcript: 'Tekstivastine', announcement: 'Tiedote' },
  fr: { learn_more: 'En savoir plus', get_started: 'Commencer', download_pdf: 'Télécharger le PDF', menu: 'Menu', open_menu: 'Ouvrir le menu', close_menu: 'Fermer le menu', search: 'Rechercher…', on_this_page: 'Sur cette page', previous: 'Précédent', next: 'Suivant', continue: 'Continuer', close: 'Fermer', enlarge_image: 'Agrandir', before: 'Avant', after: 'Après', pause_animation: 'Mettre l’animation en pause', play_animation: 'Lire l’animation', transcript: 'Transcription', announcement: 'Annonce' },
  pl: { learn_more: 'Dowiedz się więcej', get_started: 'Zacznij', download_pdf: 'Pobierz PDF', menu: 'Menu', open_menu: 'Otwórz menu', close_menu: 'Zamknij menu', search: 'Szukaj…', on_this_page: 'Na tej stronie', previous: 'Poprzednia', next: 'Następna', continue: 'Dalej', close: 'Zamknij', enlarge_image: 'Powiększ', before: 'Przed', after: 'Po', pause_animation: 'Wstrzymaj animację', play_animation: 'Odtwórz animację', transcript: 'Transkrypcja', announcement: 'Ogłoszenie' },
  it: { learn_more: 'Scopri di più', get_started: 'Inizia', download_pdf: 'Scarica il PDF', menu: 'Menu', open_menu: 'Apri il menu', close_menu: 'Chiudi il menu', search: 'Cerca…', on_this_page: 'In questa pagina', previous: 'Precedente', next: 'Successivo', continue: 'Continua', close: 'Chiudi', enlarge_image: 'Ingrandisci', before: 'Prima', after: 'Dopo', pause_animation: 'Metti in pausa l’animazione', play_animation: 'Riproduci l’animazione', transcript: 'Trascrizione', announcement: 'Avviso' },
  es: { learn_more: 'Más información', get_started: 'Empezar', download_pdf: 'Descargar PDF', menu: 'Menú', open_menu: 'Abrir menú', close_menu: 'Cerrar menú', search: 'Buscar…', on_this_page: 'En esta página', previous: 'Anterior', next: 'Siguiente', continue: 'Continuar', close: 'Cerrar', enlarge_image: 'Ampliar', before: 'Antes', after: 'Después', pause_animation: 'Pausar animación', play_animation: 'Reproducir animación', transcript: 'Transcripción', announcement: 'Aviso' },
  pt: { learn_more: 'Saiba mais', get_started: 'Começar', download_pdf: 'Baixar PDF', menu: 'Menu', open_menu: 'Abrir menu', close_menu: 'Fechar menu', search: 'Pesquisar…', on_this_page: 'Nesta página', previous: 'Anterior', next: 'Próximo', continue: 'Continuar', close: 'Fechar', enlarge_image: 'Ampliar', before: 'Antes', after: 'Depois', pause_animation: 'Pausar animação', play_animation: 'Reproduzir animação', transcript: 'Transcrição', announcement: 'Aviso' },
  ru: { learn_more: 'Подробнее', get_started: 'Начать', download_pdf: 'Скачать PDF', menu: 'Меню', open_menu: 'Открыть меню', close_menu: 'Закрыть меню', search: 'Поиск…', on_this_page: 'На этой странице', previous: 'Назад', next: 'Далее', continue: 'Продолжить', close: 'Закрыть', enlarge_image: 'Увеличить', before: 'До', after: 'После', pause_animation: 'Приостановить анимацию', play_animation: 'Воспроизвести анимацию', transcript: 'Расшифровка', announcement: 'Объявление' },
  uk: { learn_more: 'Докладніше', get_started: 'Почати', download_pdf: 'Завантажити PDF', menu: 'Меню', open_menu: 'Відкрити меню', close_menu: 'Закрити меню', search: 'Пошук…', on_this_page: 'На цій сторінці', previous: 'Назад', next: 'Далі', continue: 'Продовжити', close: 'Закрити', enlarge_image: 'Збільшити', before: 'До', after: 'Після', pause_animation: 'Призупинити анімацію', play_animation: 'Відтворити анімацію', transcript: 'Розшифровка', announcement: 'Оголошення' },
  cs: { learn_more: 'Více informací', get_started: 'Začít', download_pdf: 'Stáhnout PDF', menu: 'Nabídka', open_menu: 'Otevřít nabídku', close_menu: 'Zavřít nabídku', search: 'Hledat…', on_this_page: 'Na této stránce', previous: 'Předchozí', next: 'Další', continue: 'Pokračovat', close: 'Zavřít', enlarge_image: 'Zvětšit', before: 'Před', after: 'Po', pause_animation: 'Pozastavit animaci', play_animation: 'Přehrát animaci', transcript: 'Přepis', announcement: 'Oznámení' },
  sk: { learn_more: 'Viac informácií', get_started: 'Začať', download_pdf: 'Stiahnuť PDF', menu: 'Ponuka', open_menu: 'Otvoriť ponuku', close_menu: 'Zavrieť ponuku', search: 'Hľadať…', on_this_page: 'Na tejto stránke', previous: 'Predchádzajúca', next: 'Ďalšia', continue: 'Pokračovať', close: 'Zavrieť', enlarge_image: 'Zväčšiť', before: 'Pred', after: 'Po', pause_animation: 'Pozastaviť animáciu', play_animation: 'Prehrať animáciu', transcript: 'Prepis', announcement: 'Oznámenie' },
  hu: { learn_more: 'Tudjon meg többet', get_started: 'Kezdés', download_pdf: 'PDF letöltése', menu: 'Menü', open_menu: 'Menü megnyitása', close_menu: 'Menü bezárása', search: 'Keresés…', on_this_page: 'Ezen az oldalon', previous: 'Előző', next: 'Következő', continue: 'Tovább', close: 'Bezárás', enlarge_image: 'Nagyítás', before: 'Előtte', after: 'Utána', pause_animation: 'Animáció szüneteltetése', play_animation: 'Animáció lejátszása', transcript: 'Átirat', announcement: 'Közlemény' },
  ro: { learn_more: 'Află mai multe', get_started: 'Începe', download_pdf: 'Descarcă PDF', menu: 'Meniu', open_menu: 'Deschide meniul', close_menu: 'Închide meniul', search: 'Caută…', on_this_page: 'Pe această pagină', previous: 'Anterior', next: 'Următor', continue: 'Continuă', close: 'Închide', enlarge_image: 'Mărește', before: 'Înainte', after: 'După', pause_animation: 'Întrerupe animația', play_animation: 'Redă animația', transcript: 'Transcriere', announcement: 'Anunț' },
  bg: { learn_more: 'Научете повече', get_started: 'Започнете', download_pdf: 'Изтеглете PDF', menu: 'Меню', open_menu: 'Отваряне на менюто', close_menu: 'Затваряне на менюто', search: 'Търсене…', on_this_page: 'На тази страница', previous: 'Назад', next: 'Напред', continue: 'Продължи', close: 'Затваряне', enlarge_image: 'Уголемяване', before: 'Преди', after: 'След', pause_animation: 'Пауза на анимацията', play_animation: 'Пусни анимацията', transcript: 'Препис', announcement: 'Съобщение' },
  hr: { learn_more: 'Saznajte više', get_started: 'Započnite', download_pdf: 'Preuzmite PDF', menu: 'Izbornik', open_menu: 'Otvori izbornik', close_menu: 'Zatvori izbornik', search: 'Pretraži…', on_this_page: 'Na ovoj stranici', previous: 'Prethodna', next: 'Sljedeća', continue: 'Nastavi', close: 'Zatvori', enlarge_image: 'Povećaj', before: 'Prije', after: 'Poslije', pause_animation: 'Pauziraj animaciju', play_animation: 'Pokreni animaciju', transcript: 'Transkript', announcement: 'Obavijest' },
  sr: { learn_more: 'Сазнајте више', get_started: 'Започните', download_pdf: 'Преузмите PDF', menu: 'Мени', open_menu: 'Отвори мени', close_menu: 'Затвори мени', search: 'Претрага…', on_this_page: 'На овој страници', previous: 'Претходна', next: 'Следећа', continue: 'Настави', close: 'Затвори', enlarge_image: 'Увећај', before: 'Пре', after: 'После', pause_animation: 'Паузирај анимацију', play_animation: 'Пусти анимацију', transcript: 'Транскрипт', announcement: 'Обавештење' },
  bs: { learn_more: 'Saznajte više', get_started: 'Započnite', download_pdf: 'Preuzmite PDF', menu: 'Meni', open_menu: 'Otvori meni', close_menu: 'Zatvori meni', search: 'Pretraga…', on_this_page: 'Na ovoj stranici', previous: 'Prethodna', next: 'Sljedeća', continue: 'Nastavi', close: 'Zatvori', enlarge_image: 'Povećaj', before: 'Prije', after: 'Poslije', pause_animation: 'Pauziraj animaciju', play_animation: 'Pokreni animaciju', transcript: 'Transkript', announcement: 'Obavještenje' },
  sl: { learn_more: 'Več o tem', get_started: 'Začnite', download_pdf: 'Prenesi PDF', menu: 'Meni', open_menu: 'Odpri meni', close_menu: 'Zapri meni', search: 'Iskanje…', on_this_page: 'Na tej strani', previous: 'Prejšnja', next: 'Naslednja', continue: 'Nadaljuj', close: 'Zapri', enlarge_image: 'Povečaj', before: 'Prej', after: 'Potem', pause_animation: 'Začasno ustavi animacijo', play_animation: 'Predvajaj animacijo', transcript: 'Prepis', announcement: 'Obvestilo' },
  mk: { learn_more: 'Дознајте повеќе', get_started: 'Започнете', download_pdf: 'Преземете PDF', menu: 'Мени', open_menu: 'Отвори мени', close_menu: 'Затвори мени', search: 'Пребарување…', on_this_page: 'На оваа страница', previous: 'Претходна', next: 'Следна', continue: 'Продолжи', close: 'Затвори', enlarge_image: 'Зголеми', before: 'Пред', after: 'Потоа', pause_animation: 'Паузирај ја анимацијата', play_animation: 'Пушти ја анимацијата', transcript: 'Транскрипт', announcement: 'Известување' },
  sq: { learn_more: 'Mësoni më shumë', get_started: 'Filloni', download_pdf: 'Shkarko PDF', menu: 'Menyja', open_menu: 'Hap menynë', close_menu: 'Mbyll menynë', search: 'Kërko…', on_this_page: 'Në këtë faqe', previous: 'E mëparshme', next: 'Tjetra', continue: 'Vazhdo', close: 'Mbyll', enlarge_image: 'Zmadho', before: 'Para', after: 'Pas', pause_animation: 'Ndalo animacionin', play_animation: 'Luaj animacionin', transcript: 'Transkripti', announcement: 'Njoftim' },
  el: { learn_more: 'Μάθετε περισσότερα', get_started: 'Ξεκινήστε', download_pdf: 'Λήψη PDF', menu: 'Μενού', open_menu: 'Άνοιγμα μενού', close_menu: 'Κλείσιμο μενού', search: 'Αναζήτηση…', on_this_page: 'Σε αυτή τη σελίδα', previous: 'Προηγούμενη', next: 'Επόμενη', continue: 'Συνέχεια', close: 'Κλείσιμο', enlarge_image: 'Μεγέθυνση', before: 'Πριν', after: 'Μετά', pause_animation: 'Παύση κινούμενης εικόνας', play_animation: 'Αναπαραγωγή κινούμενης εικόνας', transcript: 'Απομαγνητοφώνηση', announcement: 'Ανακοίνωση' },
  lt: { learn_more: 'Sužinokite daugiau', get_started: 'Pradėkite', download_pdf: 'Atsisiųsti PDF', menu: 'Meniu', open_menu: 'Atidaryti meniu', close_menu: 'Uždaryti meniu', search: 'Ieškoti…', on_this_page: 'Šiame puslapyje', previous: 'Ankstesnis', next: 'Kitas', continue: 'Tęsti', close: 'Uždaryti', enlarge_image: 'Padidinti', before: 'Prieš', after: 'Po', pause_animation: 'Pristabdyti animaciją', play_animation: 'Paleisti animaciją', transcript: 'Nuorašas', announcement: 'Pranešimas' },
  lv: { learn_more: 'Uzzināt vairāk', get_started: 'Sākt', download_pdf: 'Lejupielādēt PDF', menu: 'Izvēlne', open_menu: 'Atvērt izvēlni', close_menu: 'Aizvērt izvēlni', search: 'Meklēt…', on_this_page: 'Šajā lapā', previous: 'Iepriekšējā', next: 'Nākamā', continue: 'Turpināt', close: 'Aizvērt', enlarge_image: 'Palielināt', before: 'Pirms', after: 'Pēc', pause_animation: 'Pauzēt animāciju', play_animation: 'Atskaņot animāciju', transcript: 'Atšifrējums', announcement: 'Paziņojums' },
  et: { learn_more: 'Loe lähemalt', get_started: 'Alusta', download_pdf: 'Laadi PDF alla', menu: 'Menüü', open_menu: 'Ava menüü', close_menu: 'Sulge menüü', search: 'Otsi…', on_this_page: 'Sellel lehel', previous: 'Eelmine', next: 'Järgmine', continue: 'Jätka', close: 'Sulge', enlarge_image: 'Suurenda', before: 'Enne', after: 'Pärast', pause_animation: 'Peata animatsioon', play_animation: 'Esita animatsioon', transcript: 'Transkriptsioon', announcement: 'Teadaanne' },
  is: { learn_more: 'Nánar', get_started: 'Byrja', download_pdf: 'Sækja PDF', menu: 'Valmynd', open_menu: 'Opna valmynd', close_menu: 'Loka valmynd', search: 'Leita…', on_this_page: 'Á þessari síðu', previous: 'Fyrri', next: 'Næsta', continue: 'Áfram', close: 'Loka', enlarge_image: 'Stækka', before: 'Fyrir', after: 'Eftir', pause_animation: 'Gera hlé á hreyfimynd', play_animation: 'Spila hreyfimynd', transcript: 'Uppskrift', announcement: 'Tilkynning' },
  tr: { learn_more: 'Daha fazla bilgi', get_started: 'Başlayın', download_pdf: "PDF'yi indir", menu: 'Menü', open_menu: 'Menüyü aç', close_menu: 'Menüyü kapat', search: 'Ara…', on_this_page: 'Bu sayfada', previous: 'Önceki', next: 'Sonraki', continue: 'Devam', close: 'Kapat', enlarge_image: 'Büyüt', before: 'Önce', after: 'Sonra', pause_animation: 'Animasyonu duraklat', play_animation: 'Animasyonu oynat', transcript: 'Döküm', announcement: 'Duyuru' },
  az: { learn_more: 'Ətraflı', get_started: 'Başlayın', download_pdf: 'PDF-i yüklə', menu: 'Menyu', open_menu: 'Menyunu aç', close_menu: 'Menyunu bağla', search: 'Axtar…', on_this_page: 'Bu səhifədə', previous: 'Əvvəlki', next: 'Növbəti', continue: 'Davam et', close: 'Bağla', enlarge_image: 'Böyüt', before: 'Əvvəl', after: 'Sonra', pause_animation: 'Animasiyanı dayandır', play_animation: 'Animasiyanı oynat', transcript: 'Mətn', announcement: 'Elan' },
  kk: { learn_more: 'Толығырақ', get_started: 'Бастау', download_pdf: 'PDF жүктеу', menu: 'Мәзір', open_menu: 'Мәзірді ашу', close_menu: 'Мәзірді жабу', search: 'Іздеу…', on_this_page: 'Осы бетте', previous: 'Алдыңғы', next: 'Келесі', continue: 'Жалғастыру', close: 'Жабу', enlarge_image: 'Үлкейту', before: 'Дейін', after: 'Кейін', pause_animation: 'Анимацияны кідірту', play_animation: 'Анимацияны ойнату', transcript: 'Транскрипт', announcement: 'Хабарландыру' },
  ka: { learn_more: 'გაიგეთ მეტი', get_started: 'დაწყება', download_pdf: 'PDF-ის ჩამოტვირთვა', menu: 'მენიუ', open_menu: 'მენიუს გახსნა', close_menu: 'მენიუს დახურვა', search: 'ძიება…', on_this_page: 'ამ გვერდზე', previous: 'წინა', next: 'შემდეგი', continue: 'გაგრძელება', close: 'დახურვა', enlarge_image: 'გადიდება', before: 'მანამდე', after: 'შემდეგ', pause_animation: 'ანიმაციის დაპაუზება', play_animation: 'ანიმაციის დაკვრა', transcript: 'ტრანსკრიპტი', announcement: 'განცხადება' },
  ar: { learn_more: 'اعرف المزيد', get_started: 'ابدأ الآن', download_pdf: 'تنزيل PDF', menu: 'القائمة', open_menu: 'فتح القائمة', close_menu: 'إغلاق القائمة', search: 'بحث…', on_this_page: 'في هذه الصفحة', previous: 'السابق', next: 'التالي', continue: 'متابعة', close: 'إغلاق', enlarge_image: 'تكبير', before: 'قبل', after: 'بعد', pause_animation: 'إيقاف الحركة مؤقتًا', play_animation: 'تشغيل الحركة', transcript: 'النص المكتوب', announcement: 'إعلان' },
  he: { learn_more: 'מידע נוסף', get_started: 'להתחיל', download_pdf: 'הורדת PDF', menu: 'תפריט', open_menu: 'פתיחת התפריט', close_menu: 'סגירת התפריט', search: 'חיפוש…', on_this_page: 'בדף זה', previous: 'הקודם', next: 'הבא', continue: 'המשך', close: 'סגירה', enlarge_image: 'הגדלה', before: 'לפני', after: 'אחרי', pause_animation: 'השהיית האנימציה', play_animation: 'הפעלת האנימציה', transcript: 'תמלול', announcement: 'הודעה' },
  fa: { learn_more: 'بیشتر بدانید', get_started: 'شروع کنید', download_pdf: 'دانلود PDF', menu: 'منو', open_menu: 'باز کردن منو', close_menu: 'بستن منو', search: 'جستجو…', on_this_page: 'در این صفحه', previous: 'قبلی', next: 'بعدی', continue: 'ادامه', close: 'بستن', enlarge_image: 'بزرگ‌نمایی', before: 'قبل', after: 'بعد', pause_animation: 'مکث پویانمایی', play_animation: 'پخش پویانمایی', transcript: 'متن گفتار', announcement: 'اطلاعیه' },
  ur: { learn_more: 'مزید جانیں', get_started: 'شروع کریں', download_pdf: 'PDF ڈاؤن لوڈ کریں', menu: 'مینو', open_menu: 'مینو کھولیں', close_menu: 'مینو بند کریں', search: 'تلاش کریں…', on_this_page: 'اس صفحے پر', previous: 'پچھلا', next: 'اگلا', continue: 'جاری رکھیں', close: 'بند کریں', enlarge_image: 'بڑا کریں', before: 'پہلے', after: 'بعد', pause_animation: 'اینیمیشن روکیں', play_animation: 'اینیمیشن چلائیں', transcript: 'تحریری متن', announcement: 'اعلان' },
  hi: { learn_more: 'और जानें', get_started: 'शुरू करें', download_pdf: 'PDF डाउनलोड करें', menu: 'मेनू', open_menu: 'मेनू खोलें', close_menu: 'मेनू बंद करें', search: 'खोजें…', on_this_page: 'इस पेज पर', previous: 'पिछला', next: 'अगला', continue: 'जारी रखें', close: 'बंद करें', enlarge_image: 'बड़ा करें', before: 'पहले', after: 'बाद में', pause_animation: 'एनिमेशन रोकें', play_animation: 'एनिमेशन चलाएँ', transcript: 'प्रतिलेख', announcement: 'घोषणा' },
  bn: { learn_more: 'আরও জানুন', get_started: 'শুরু করুন', download_pdf: 'PDF ডাউনলোড করুন', menu: 'মেনু', open_menu: 'মেনু খুলুন', close_menu: 'মেনু বন্ধ করুন', search: 'অনুসন্ধান…', on_this_page: 'এই পৃষ্ঠায়', previous: 'আগের', next: 'পরের', continue: 'চালিয়ে যান', close: 'বন্ধ করুন', enlarge_image: 'বড় করুন', before: 'আগে', after: 'পরে', pause_animation: 'অ্যানিমেশন থামান', play_animation: 'অ্যানিমেশন চালান', transcript: 'প্রতিলিপি', announcement: 'ঘোষণা' },
  ta: { learn_more: 'மேலும் அறிக', get_started: 'தொடங்குங்கள்', download_pdf: 'PDF பதிவிறக்கு', menu: 'மெனு', open_menu: 'மெனுவைத் திற', close_menu: 'மெனுவை மூடு', search: 'தேடு…', on_this_page: 'இந்தப் பக்கத்தில்', previous: 'முந்தையது', next: 'அடுத்தது', continue: 'தொடர்க', close: 'மூடு', enlarge_image: 'பெரிதாக்கு', before: 'முன்', after: 'பின்', pause_animation: 'அனிமேஷனை இடைநிறுத்து', play_animation: 'அனிமேஷனை இயக்கு', transcript: 'எழுத்துப்படி', announcement: 'அறிவிப்பு' },
  th: { learn_more: 'ดูเพิ่มเติม', get_started: 'เริ่มต้นใช้งาน', download_pdf: 'ดาวน์โหลด PDF', menu: 'เมนู', open_menu: 'เปิดเมนู', close_menu: 'ปิดเมนู', search: 'ค้นหา…', on_this_page: 'ในหน้านี้', previous: 'ก่อนหน้า', next: 'ถัดไป', continue: 'ดำเนินการต่อ', close: 'ปิด', enlarge_image: 'ขยาย', before: 'ก่อน', after: 'หลัง', pause_animation: 'หยุดภาพเคลื่อนไหวชั่วคราว', play_animation: 'เล่นภาพเคลื่อนไหว', transcript: 'บทถอดความ', announcement: 'ประกาศ' },
  vi: { learn_more: 'Tìm hiểu thêm', get_started: 'Bắt đầu', download_pdf: 'Tải xuống PDF', menu: 'Menu', open_menu: 'Mở menu', close_menu: 'Đóng menu', search: 'Tìm kiếm…', on_this_page: 'Trên trang này', previous: 'Trước', next: 'Tiếp', continue: 'Tiếp tục', close: 'Đóng', enlarge_image: 'Phóng to', before: 'Trước', after: 'Sau', pause_animation: 'Tạm dừng hoạt ảnh', play_animation: 'Phát hoạt ảnh', transcript: 'Bản chép lời', announcement: 'Thông báo' },
  id: { learn_more: 'Selengkapnya', get_started: 'Mulai', download_pdf: 'Unduh PDF', menu: 'Menu', open_menu: 'Buka menu', close_menu: 'Tutup menu', search: 'Cari…', on_this_page: 'Di halaman ini', previous: 'Sebelumnya', next: 'Berikutnya', continue: 'Lanjutkan', close: 'Tutup', enlarge_image: 'Perbesar', before: 'Sebelum', after: 'Sesudah', pause_animation: 'Jeda animasi', play_animation: 'Putar animasi', transcript: 'Transkrip', announcement: 'Pengumuman' },
  ms: { learn_more: 'Ketahui lebih lanjut', get_started: 'Mulakan', download_pdf: 'Muat turun PDF', menu: 'Menu', open_menu: 'Buka menu', close_menu: 'Tutup menu', search: 'Cari…', on_this_page: 'Di halaman ini', previous: 'Sebelumnya', next: 'Seterusnya', continue: 'Teruskan', close: 'Tutup', enlarge_image: 'Besarkan', before: 'Sebelum', after: 'Selepas', pause_animation: 'Jeda animasi', play_animation: 'Main animasi', transcript: 'Transkrip', announcement: 'Pengumuman' },
  ja: { learn_more: '詳しく見る', get_started: 'はじめる', download_pdf: 'PDFをダウンロード', menu: 'メニュー', open_menu: 'メニューを開く', close_menu: 'メニューを閉じる', search: '検索…', on_this_page: 'このページの内容', previous: '前へ', next: '次へ', continue: '続ける', close: '閉じる', enlarge_image: '拡大表示', before: '前', after: '後', pause_animation: 'アニメーションを一時停止', play_animation: 'アニメーションを再生', transcript: '文字起こし', announcement: 'お知らせ' },
  ko: { learn_more: '자세히 알아보기', get_started: '시작하기', download_pdf: 'PDF 다운로드', menu: '메뉴', open_menu: '메뉴 열기', close_menu: '메뉴 닫기', search: '검색…', on_this_page: '이 페이지의 내용', previous: '이전', next: '다음', continue: '계속', close: '닫기', enlarge_image: '크게 보기', before: '이전', after: '이후', pause_animation: '애니메이션 일시정지', play_animation: '애니메이션 재생', transcript: '스크립트', announcement: '공지' },
  zh: { learn_more: '了解更多', get_started: '开始使用', download_pdf: '下载 PDF', menu: '菜单', open_menu: '打开菜单', close_menu: '关闭菜单', search: '搜索…', on_this_page: '本页内容', previous: '上一页', next: '下一页', continue: '继续', close: '关闭', enlarge_image: '放大查看', before: '之前', after: '之后', pause_animation: '暂停动画', play_animation: '播放动画', transcript: '文字稿', announcement: '公告' },
  'zh-Hant': { learn_more: '了解更多', get_started: '開始使用', download_pdf: '下載 PDF', menu: '選單', open_menu: '開啟選單', close_menu: '關閉選單', search: '搜尋…', on_this_page: '本頁內容', previous: '上一頁', next: '下一頁', continue: '繼續', close: '關閉', enlarge_image: '放大檢視', before: '之前', after: '之後', pause_animation: '暫停動畫', play_animation: '播放動畫', transcript: '文字稿', announcement: '公告' },
  ca: { learn_more: 'Més informació', get_started: 'Comença', download_pdf: 'Baixa el PDF', menu: 'Menú', open_menu: 'Obre el menú', close_menu: 'Tanca el menú', search: 'Cerca…', on_this_page: 'En aquesta pàgina', previous: 'Anterior', next: 'Següent', continue: 'Continua', close: 'Tanca', enlarge_image: 'Amplia', before: 'Abans', after: 'Després', pause_animation: 'Posa en pausa l’animació', play_animation: 'Reprodueix l’animació', transcript: 'Transcripció', announcement: 'Avís' },
} as const satisfies Record<UiLanguage, Record<string, string>>;

export type UiLabelKey = keyof typeof UI_LABELS.en | 'home';

export function uiLabel(language: unknown, key: UiLabelKey): string {
  return key === 'home' ? uiText(language, 'home') : UI_LABELS[uiLanguage(language)][key];
}

/** The page-language label for a field left unset or at its English default, otherwise the value itself. */
export function localizeDefaultLabel(value: unknown, key: UiLabelKey, language: unknown): unknown {
  return value === undefined || value === uiLabel('en', key) ? uiLabel(language, key) : value;
}

/**
 * Words of the opening-hours formats of `core/site_field`: a closed day, open
 * now until a time, the next opening (`{day}` is today, tomorrow or a weekday
 * name from Intl) and the words for today and tomorrow.
 */
export interface OpeningHoursText { closed: string; open_until: string; opens: string; today: string; tomorrow: string }
type OpeningHoursRow = [closed: string, open_until: string, opens: string, today: string, tomorrow: string];
const OPENING_HOURS_TEXT: Record<UiLanguage, OpeningHoursRow> = {
  en: ['Closed', 'Open now, until {time}', 'Opens {day} {time}', 'today', 'tomorrow'],
  sv: ['Stängt', 'Öppet nu, till {time}', 'Öppnar {day} {time}', 'i dag', 'i morgon'],
  nb: ['Stengt', 'Åpent nå, til {time}', 'Åpner {day} {time}', 'i dag', 'i morgen'],
  da: ['Lukket', 'Åbent nu, til {time}', 'Åbner {day} {time}', 'i dag', 'i morgen'],
  de: ['Geschlossen', 'Jetzt geöffnet, bis {time}', 'Öffnet {day} um {time}', 'heute', 'morgen'],
  nl: ['Gesloten', 'Nu open, tot {time}', 'Opent {day} om {time}', 'vandaag', 'morgen'],
  fi: ['Suljettu', 'Avoinna nyt, {time} asti', 'Avautuu: {day} klo {time}', 'tänään', 'huomenna'],
  fr: ['Fermé', 'Ouvert, jusqu’à {time}', 'Ouvre {day} à {time}', 'aujourd’hui', 'demain'],
  pl: ['Zamknięte', 'Otwarte, do {time}', 'Otwarcie: {day}, {time}', 'dziś', 'jutro'],
  it: ['Chiuso', 'Aperto ora, fino alle {time}', 'Apre {day} alle {time}', 'oggi', 'domani'],
  es: ['Cerrado', 'Abierto ahora, hasta las {time}', 'Abre {day} a las {time}', 'hoy', 'mañana'],
  pt: ['Fechado', 'Aberto agora, até às {time}', 'Abre {day} às {time}', 'hoje', 'amanhã'],
  ru: ['Закрыто', 'Открыто, до {time}', 'Откроется: {day}, {time}', 'сегодня', 'завтра'],
  uk: ['Зачинено', 'Відчинено, до {time}', 'Відчиниться: {day}, {time}', 'сьогодні', 'завтра'],
  cs: ['Zavřeno', 'Otevřeno, do {time}', 'Otevírá: {day} {time}', 'dnes', 'zítra'],
  sk: ['Zatvorené', 'Otvorené, do {time}', 'Otvára: {day} {time}', 'dnes', 'zajtra'],
  hu: ['Zárva', 'Most nyitva, {time}-ig', 'Nyit: {day} {time}', 'ma', 'holnap'],
  ro: ['Închis', 'Deschis acum, până la {time}', 'Se deschide {day} la {time}', 'azi', 'mâine'],
  bg: ['Затворено', 'Отворено, до {time}', 'Отваря: {day}, {time}', 'днес', 'утре'],
  hr: ['Zatvoreno', 'Otvoreno, do {time}', 'Otvara: {day} u {time}', 'danas', 'sutra'],
  sr: ['Затворено', 'Отворено, до {time}', 'Отвара: {day} у {time}', 'данас', 'сутра'],
  bs: ['Zatvoreno', 'Otvoreno, do {time}', 'Otvara: {day} u {time}', 'danas', 'sutra'],
  sl: ['Zaprto', 'Odprto, do {time}', 'Odpre: {day} ob {time}', 'danes', 'jutri'],
  mk: ['Затворено', 'Отворено, до {time}', 'Се отвора: {day} во {time}', 'денес', 'утре'],
  sq: ['Mbyllur', 'Hapur tani, deri në {time}', 'Hapet: {day} në {time}', 'sot', 'nesër'],
  el: ['Κλειστό', 'Ανοιχτό τώρα, έως τις {time}', 'Ανοίγει: {day} στις {time}', 'σήμερα', 'αύριο'],
  lt: ['Uždaryta', 'Atidaryta, iki {time}', 'Atsidaro: {day} {time}', 'šiandien', 'rytoj'],
  lv: ['Slēgts', 'Atvērts, līdz {time}', 'Atver: {day} {time}', 'šodien', 'rīt'],
  et: ['Suletud', 'Avatud, kuni {time}', 'Avatakse: {day} {time}', 'täna', 'homme'],
  is: ['Lokað', 'Opið núna, til {time}', 'Opnar: {day} kl. {time}', 'í dag', 'á morgun'],
  tr: ['Kapalı', 'Şu an açık, {time} saatine kadar', 'Açılış: {day} {time}', 'bugün', 'yarın'],
  az: ['Bağlıdır', 'İndi açıqdır, {time}-dək', 'Açılır: {day} {time}', 'bu gün', 'sabah'],
  kk: ['Жабық', 'Қазір ашық, {time} дейін', 'Ашылады: {day} {time}', 'бүгін', 'ертең'],
  ka: ['დაკეტილია', 'ახლა ღიაა, {time}-მდე', 'იხსნება: {day} {time}', 'დღეს', 'ხვალ'],
  ar: ['مغلق', 'مفتوح الآن حتى {time}', 'يفتح {day} الساعة {time}', 'اليوم', 'غدًا'],
  he: ['סגור', 'פתוח עכשיו, עד {time}', 'נפתח {day} ב-{time}', 'היום', 'מחר'],
  fa: ['بسته', 'اکنون باز است، تا {time}', 'باز می‌شود: {day} ساعت {time}', 'امروز', 'فردا'],
  ur: ['بند', 'ابھی کھلا ہے، {time} تک', 'کھلے گا: {day} {time}', 'آج', 'کل'],
  hi: ['बंद', 'अभी खुला है, {time} तक', 'खुलेगा: {day} {time}', 'आज', 'कल'],
  bn: ['বন্ধ', 'এখন খোলা, {time} পর্যন্ত', 'খুলবে: {day} {time}', 'আজ', 'আগামীকাল'],
  ta: ['மூடப்பட்டுள்ளது', 'இப்போது திறந்துள்ளது, {time} வரை', 'திறக்கும்: {day} {time}', 'இன்று', 'நாளை'],
  th: ['ปิด', 'เปิดอยู่ ถึง {time}', 'เปิด{day} เวลา {time}', 'วันนี้', 'พรุ่งนี้'],
  vi: ['Đóng cửa', 'Đang mở cửa, đến {time}', 'Mở cửa {day} lúc {time}', 'hôm nay', 'ngày mai'],
  id: ['Tutup', 'Buka sekarang, sampai {time}', 'Buka {day} pukul {time}', 'hari ini', 'besok'],
  ms: ['Tutup', 'Dibuka sekarang, hingga {time}', 'Dibuka {day} pada {time}', 'hari ini', 'esok'],
  ja: ['休業', '営業中（{time}まで）', '{day} {time}に開店', '今日', '明日'],
  ko: ['휴무', '영업 중, {time}까지', '{day} {time} 영업 시작', '오늘', '내일'],
  zh: ['休息', '营业中，至 {time}', '{day} {time} 开门', '今天', '明天'],
  'zh-Hant': ['休息', '營業中，至 {time}', '{day} {time} 開門', '今天', '明天'],
  ca: ['Tancat', 'Obert ara, fins a les {time}', 'Obre {day} a les {time}', 'avui', 'demà'],
};

export function openingHoursText(language: unknown): OpeningHoursText {
  const [closed, open_until, opens, today, tomorrow] = OPENING_HOURS_TEXT[uiLanguage(language)];
  return { closed, open_until, opens, today, tomorrow };
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
  if (!pattern || pattern === DEFAULT_DATE_FORMAT || pattern === 'medium') return part({ year: 'numeric', month: 'short', day: 'numeric' });
  if (pattern === 'long') return part({ year: 'numeric', month: 'long', day: 'numeric' });
  if (pattern === 'numeric') return part({ year: 'numeric', month: '2-digit', day: '2-digit' });
  if (pattern === 'iso') return date.toISOString().slice(0, 10);
  const day = date.getUTCDate(), month = date.getUTCMonth() + 1;
  return pattern.replace(/YYYY|MMMM|MMM|MM|M|DD|D/g, token => ({
    YYYY: String(date.getUTCFullYear()), MMMM: part({ month: 'long' }), MMM: part({ month: 'short' }),
    MM: String(month).padStart(2, '0'), M: String(month), DD: String(day).padStart(2, '0'), D: String(day),
  })[token]!);
}
