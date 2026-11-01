// Wording of the published 404 page, in the page's interface language.

import { uiLanguage, type UiLanguage } from './ui-text.js';

export interface NotFoundText { title: string; body: string; back: string }

const NOT_FOUND_TEXT = {
  en: { title: 'Page not found', body: "Sorry, that page doesn't exist.", back: 'Back to home' },
  sv: { title: 'Sidan hittades inte', body: 'Tyvärr finns inte den sidan.', back: 'Tillbaka till startsidan' },
  nb: { title: 'Siden ble ikke funnet', body: 'Beklager, den siden finnes ikke.', back: 'Tilbake til forsiden' },
  da: { title: 'Siden blev ikke fundet', body: 'Beklager, den side findes ikke.', back: 'Tilbage til forsiden' },
  de: { title: 'Seite nicht gefunden', body: 'Entschuldigung, diese Seite existiert nicht.', back: 'Zur Startseite' },
  fr: { title: 'Page introuvable', body: "Désolé, cette page n'existe pas.", back: "Retour à l'accueil" },
  es: { title: 'Página no encontrada', body: 'Lo sentimos, esa página no existe.', back: 'Volver al inicio' },
  nl: { title: 'Pagina niet gevonden', body: 'Sorry, die pagina bestaat niet.', back: 'Terug naar de startpagina' },
  fi: { title: 'Sivua ei löydy', body: 'Valitettavasti sivua ei ole olemassa.', back: 'Takaisin etusivulle' },
  pl: { title: 'Nie znaleziono strony', body: 'Przepraszamy, ta strona nie istnieje.', back: 'Wróć do strony głównej' },
  it: { title: 'Pagina non trovata', body: 'Spiacenti, questa pagina non esiste.', back: 'Torna alla home page' },
  pt: { title: 'Página não encontrada', body: 'Lamentamos, mas esta página não existe.', back: 'Voltar ao início' },
  ru: { title: 'Страница не найдена', body: 'К сожалению, такой страницы не существует.', back: 'Вернуться на главную' },
  uk: { title: 'Сторінку не знайдено', body: 'На жаль, такої сторінки не існує.', back: 'Повернутися на головну' },
  cs: { title: 'Stránka nenalezena', body: 'Omlouváme se, tato stránka neexistuje.', back: 'Zpět na úvodní stránku' },
  sk: { title: 'Stránka sa nenašla', body: 'Ľutujeme, táto stránka neexistuje.', back: 'Späť na domovskú stránku' },
  hu: { title: 'Az oldal nem található', body: 'Sajnáljuk, ez az oldal nem létezik.', back: 'Vissza a főoldalra' },
  ro: { title: 'Pagina nu a fost găsită', body: 'Ne pare rău, această pagină nu există.', back: 'Înapoi la pagina principală' },
  bg: { title: 'Страницата не е намерена', body: 'За съжаление тази страница не съществува.', back: 'Към началната страница' },
  hr: { title: 'Stranica nije pronađena', body: 'Nažalost, ta stranica ne postoji.', back: 'Natrag na početnu' },
  sr: { title: 'Страница није пронађена', body: 'Нажалост, та страница не постоји.', back: 'Назад на почетну' },
  bs: { title: 'Stranica nije pronađena', body: 'Nažalost, ta stranica ne postoji.', back: 'Nazad na početnu' },
  sl: { title: 'Stran ni bila najdena', body: 'Žal ta stran ne obstaja.', back: 'Nazaj na domačo stran' },
  mk: { title: 'Страницата не е пронајдена', body: 'За жал, таа страница не постои.', back: 'Назад на почетна' },
  sq: { title: 'Faqja nuk u gjet', body: 'Na vjen keq, kjo faqe nuk ekziston.', back: 'Kthehu në faqen kryesore' },
  el: { title: 'Η σελίδα δεν βρέθηκε', body: 'Λυπούμαστε, αυτή η σελίδα δεν υπάρχει.', back: 'Επιστροφή στην αρχική' },
  lt: { title: 'Puslapis nerastas', body: 'Atsiprašome, tokio puslapio nėra.', back: 'Grįžti į pradžią' },
  lv: { title: 'Lapa nav atrasta', body: 'Atvainojiet, šī lapa neeksistē.', back: 'Atpakaļ uz sākumlapu' },
  et: { title: 'Lehte ei leitud', body: 'Vabandust, sellist lehte ei ole olemas.', back: 'Tagasi avalehele' },
  is: { title: 'Síða fannst ekki', body: 'Því miður er þessi síða ekki til.', back: 'Aftur á forsíðu' },
  tr: { title: 'Sayfa bulunamadı', body: 'Üzgünüz, bu sayfa mevcut değil.', back: 'Ana sayfaya dön' },
  az: { title: 'Səhifə tapılmadı', body: 'Təəssüf ki, belə səhifə mövcud deyil.', back: 'Ana səhifəyə qayıt' },
  kk: { title: 'Бет табылмады', body: 'Кешіріңіз, мұндай бет жоқ.', back: 'Басты бетке оралу' },
  ka: { title: 'გვერდი ვერ მოიძებნა', body: 'სამწუხაროდ, ეს გვერდი არ არსებობს.', back: 'მთავარ გვერდზე დაბრუნება' },
  ar: { title: 'لم يتم العثور على الصفحة', body: 'عذرًا، هذه الصفحة غير موجودة.', back: 'العودة إلى الصفحة الرئيسية' },
  he: { title: 'הדף לא נמצא', body: 'מצטערים, הדף הזה לא קיים.', back: 'חזרה לדף הבית' },
  fa: { title: 'صفحه پیدا نشد', body: 'متأسفیم، این صفحه وجود ندارد.', back: 'بازگشت به صفحه اصلی' },
  ur: { title: 'صفحہ نہیں ملا', body: 'معذرت، یہ صفحہ موجود نہیں ہے۔', back: 'ہوم پیج پر واپس جائیں' },
  hi: { title: 'पेज नहीं मिला', body: 'क्षमा करें, यह पेज मौजूद नहीं है।', back: 'होम पेज पर वापस जाएँ' },
  bn: { title: 'পৃষ্ঠাটি পাওয়া যায়নি', body: 'দুঃখিত, এই পৃষ্ঠাটির কোনো অস্তিত্ব নেই।', back: 'হোম পেজে ফিরে যান' },
  ta: { title: 'பக்கம் கிடைக்கவில்லை', body: 'மன்னிக்கவும், அந்தப் பக்கம் இல்லை.', back: 'முகப்புக்குத் திரும்பு' },
  th: { title: 'ไม่พบหน้าที่คุณค้นหา', body: 'ขออภัย ไม่มีหน้านี้อยู่ในเว็บไซต์', back: 'กลับไปหน้าแรก' },
  vi: { title: 'Không tìm thấy trang', body: 'Rất tiếc, trang này không tồn tại.', back: 'Quay lại trang chủ' },
  id: { title: 'Halaman tidak ditemukan', body: 'Maaf, halaman tersebut tidak ada.', back: 'Kembali ke beranda' },
  ms: { title: 'Halaman tidak ditemui', body: 'Maaf, halaman itu tidak wujud.', back: 'Kembali ke laman utama' },
  ja: { title: 'ページが見つかりません', body: '申し訳ありませんが、お探しのページは存在しません。', back: 'ホームに戻る' },
  ko: { title: '페이지를 찾을 수 없습니다', body: '죄송합니다. 요청하신 페이지가 존재하지 않습니다.', back: '홈으로 돌아가기' },
  zh: { title: '页面未找到', body: '抱歉，该页面不存在。', back: '返回首页' },
  'zh-Hant': { title: '找不到頁面', body: '抱歉，此頁面不存在。', back: '返回首頁' },
  ca: { title: 'No s\'ha trobat la pàgina', body: 'Ho sentim, aquesta pàgina no existeix.', back: 'Torna a l\'inici' },
} as const satisfies Record<UiLanguage, NotFoundText>;

/** Title, message and home link of the 404 page for a BCP 47 tag, English when untranslated. */
export function notFoundText(language: unknown): NotFoundText {
  return NOT_FOUND_TEXT[uiLanguage(language)];
}
