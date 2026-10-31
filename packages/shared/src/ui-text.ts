/**
 * The few interface words the platform writes itself (control labels,
 * landmarks, the cookie banner defaults) follow the page language. Languages
 * without a translation here fall back to English; a publication reports that
 * so the site can supply its own wording where settings allow it.
 */
export const UI_LANGUAGES = ['sv', 'nb', 'de', 'nl', 'fi', 'fr', 'pl', 'it', 'es', 'en'] as const;
export type UiLanguage = typeof UI_LANGUAGES[number];

/** Tags that share a built-in translation: generic Norwegian `no` reads as Bokmål. */
const UI_LANGUAGE_ALIASES: Readonly<Record<string, UiLanguage>> = { no: 'nb' };

/** Built-in interface language for a BCP 47 tag, English when untranslated. */
export function uiLanguage(language: unknown): UiLanguage {
  const tag = String(language ?? '');
  const primary = /^([a-z]{2,3})\b/i.exec(tag)?.[1]?.toLowerCase() ?? '';
  return UI_LANGUAGES.find(code => code === primary) ?? UI_LANGUAGE_ALIASES[primary] ?? 'en';
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
} as const satisfies Record<UiLanguage, Record<string, string>>;

export type UiTextKey = keyof typeof UI_TEXT.en;

export function uiText(language: unknown, key: UiTextKey): string {
  return UI_TEXT[uiLanguage(language)][key];
}
