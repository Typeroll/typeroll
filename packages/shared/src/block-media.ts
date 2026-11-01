// Markup for the media and carousel options of core blocks (render version 7).
//
// Before version 7 these fields were stored and never rendered: core/video was
// a bare iframe with the authored URL (a YouTube watch address does not embed),
// core/hero ignored video_url, core/testimonial ignored rating and the
// repeater carousel had no controls. The renderer derives the HTML here; the
// templates that include it exist only from version 7, so older sites keep
// their output byte for byte.

import { uiLanguage, type UiLanguage } from './ui-text.js';

type Data = Record<string, unknown>;
type Lang = UiLanguage;

const escapeAttr = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Interface language for the few words the platform writes itself. */
export function blockUiLanguage(language: unknown): Lang {
  return uiLanguage(language);
}

const TEXT = {
  en: { pause: 'Pause video', play: 'Play video', previous: 'Previous', next: 'Next', item: 'Show item', pauseSlides: 'Pause', playSlides: 'Play', carousel: 'Carousel', rating: (value: string) => `Rating: ${value} out of 5` },
  de: { pause: 'Video pausieren', play: 'Video abspielen', previous: 'Zurück', next: 'Weiter', item: 'Anzeigen', pauseSlides: 'Pausieren', playSlides: 'Abspielen', carousel: 'Karussell', rating: (value: string) => `Bewertung: ${value} von 5` },
  nl: { pause: 'Video pauzeren', play: 'Video afspelen', previous: 'Vorige', next: 'Volgende', item: 'Toon', pauseSlides: 'Pauzeren', playSlides: 'Afspelen', carousel: 'Carrousel', rating: (value: string) => `Beoordeling: ${value} van 5` },
  nb: { pause: 'Sett video på pause', play: 'Spill av video', previous: 'Forrige', next: 'Neste', item: 'Vis', pauseSlides: 'Pause', playSlides: 'Spill av', carousel: 'Karusell', rating: (value: string) => `Vurdering: ${value} av 5` },
  fi: { pause: 'Keskeytä video', play: 'Toista video', previous: 'Edellinen', next: 'Seuraava', item: 'Näytä', pauseSlides: 'Keskeytä', playSlides: 'Toista', carousel: 'Karuselli', rating: (value: string) => `Arvio: ${value}/5` },
  fr: { pause: 'Mettre la vidéo en pause', play: 'Lire la vidéo', previous: 'Précédent', next: 'Suivant', item: 'Afficher', pauseSlides: 'Pause', playSlides: 'Lecture', carousel: 'Carrousel', rating: (value: string) => `Note : ${value} sur 5` },
  pl: { pause: 'Wstrzymaj wideo', play: 'Odtwórz wideo', previous: 'Poprzedni', next: 'Następny', item: 'Pokaż', pauseSlides: 'Wstrzymaj', playSlides: 'Odtwórz', carousel: 'Karuzela', rating: (value: string) => `Ocena: ${value} na 5` },
  it: { pause: 'Metti in pausa il video', play: 'Riproduci il video', previous: 'Precedente', next: 'Successivo', item: 'Mostra', pauseSlides: 'Pausa', playSlides: 'Riproduci', carousel: 'Carosello', rating: (value: string) => `Valutazione: ${value} su 5` },
  es: { pause: 'Pausar vídeo', play: 'Reproducir vídeo', previous: 'Anterior', next: 'Siguiente', item: 'Mostrar', pauseSlides: 'Pausar', playSlides: 'Reproducir', carousel: 'Carrusel', rating: (value: string) => `Valoración: ${value} de 5` },
  sv: { pause: 'Pausa video', play: 'Spela video', previous: 'Föregående', next: 'Nästa', item: 'Visa', pauseSlides: 'Pausa', playSlides: 'Spela', carousel: 'Karusell', rating: (value: string) => `Betyg: ${value} av 5` },
  da: { pause: 'Sæt video på pause', play: 'Afspil video', previous: 'Forrige', next: 'Næste', item: 'Vis', pauseSlides: 'Pause', playSlides: 'Afspil', carousel: 'Karrusel', rating: (value: string) => `Bedømmelse: ${value} ud af 5` },
  pt: { pause: 'Pausar vídeo', play: 'Reproduzir vídeo', previous: 'Anterior', next: 'Próximo', item: 'Mostrar item', pauseSlides: 'Pausar', playSlides: 'Reproduzir', carousel: 'Carrossel', rating: (value: string) => `Avaliação: ${value} de 5` },
  ru: { pause: 'Приостановить видео', play: 'Воспроизвести видео', previous: 'Предыдущий слайд', next: 'Следующий слайд', item: 'Показать слайд', pauseSlides: 'Пауза', playSlides: 'Воспроизвести', carousel: 'Карусель', rating: (value: string) => `Оценка: ${value} из 5` },
  uk: { pause: 'Призупинити відео', play: 'Відтворити відео', previous: 'Попередній', next: 'Наступний', item: 'Перейти до слайда', pauseSlides: 'Пауза', playSlides: 'Відтворити', carousel: 'Карусель', rating: (value: string) => `Оцінка: ${value} з 5` },
  cs: { pause: 'Pozastavit video', play: 'Přehrát video', previous: 'Předchozí', next: 'Další', item: 'Přejít na snímek', pauseSlides: 'Pozastavit', playSlides: 'Přehrát', carousel: 'Karusel', rating: (value: string) => `Hodnocení: ${value} z 5` },
  sk: { pause: 'Pozastaviť video', play: 'Prehrať video', previous: 'Predchádzajúca', next: 'Ďalšia', item: 'Prejsť na snímku', pauseSlides: 'Pozastaviť', playSlides: 'Prehrať', carousel: 'Karusel', rating: (value: string) => `Hodnotenie: ${value} z 5` },
  hu: { pause: 'Videó szüneteltetése', play: 'Videó lejátszása', previous: 'Előző', next: 'Következő', item: 'Dia', pauseSlides: 'Szünet', playSlides: 'Lejátszás', carousel: 'Karusszel', rating: (value: string) => `Értékelés: ${value}/5` },
  ro: { pause: 'Întrerupe videoclipul', play: 'Redă videoclipul', previous: 'Anterior', next: 'Următor', item: 'Afișează elementul', pauseSlides: 'Pauză', playSlides: 'Redare', carousel: 'Carusel', rating: (value: string) => `Evaluare: ${value} din 5` },
  bg: { pause: 'Пауза на видеото', play: 'Пусни видеото', previous: 'Предишен', next: 'Следващ', item: 'Покажи елемент', pauseSlides: 'Пауза', playSlides: 'Пусни', carousel: 'Карусел', rating: (value: string) => `Оценка: ${value} от 5` },
  hr: { pause: 'Pauziraj videozapis', play: 'Reproduciraj videozapis', previous: 'Prethodno', next: 'Sljedeće', item: 'Prikaži stavku', pauseSlides: 'Pauziraj', playSlides: 'Pokreni', carousel: 'Vrtuljak', rating: (value: string) => `Ocjena: ${value} od 5` },
  sr: { pause: 'Паузирај видео', play: 'Пусти видео', previous: 'Претходно', next: 'Следеће', item: 'Прикажи ставку', pauseSlides: 'Паузирај', playSlides: 'Пусти', carousel: 'Карусел', rating: (value: string) => `Оцена: ${value} од 5` },
  bs: { pause: 'Pauziraj video', play: 'Pokreni video', previous: 'Prethodno', next: 'Sljedeće', item: 'Slajd', pauseSlides: 'Pauza', playSlides: 'Pokreni', carousel: 'Karusel', rating: (value: string) => `Ocjena: ${value} od 5` },
  sl: { pause: 'Začasno ustavi videoposnetek', play: 'Predvajaj videoposnetek', previous: 'Prejšnji', next: 'Naslednji', item: 'Prikaži element', pauseSlides: 'Začasno ustavi', playSlides: 'Predvajaj', carousel: 'Vrtiljak', rating: (value: string) => `Ocena: ${value} od 5` },
  mk: { pause: 'Паузирај го видеото', play: 'Пушти го видеото', previous: 'Претходна', next: 'Следна', item: 'Слајд', pauseSlides: 'Пауза', playSlides: 'Пушти', carousel: 'Карусел', rating: (value: string) => `Оцена: ${value} од 5` },
  sq: { pause: 'Ndalo videon', play: 'Luaj videon', previous: 'E mëparshmja', next: 'Tjetra', item: 'Sllajdi', pauseSlides: 'Pauzë', playSlides: 'Luaj', carousel: 'Karusel', rating: (value: string) => `Vlerësimi: ${value} nga 5` },
  el: { pause: 'Παύση βίντεο', play: 'Αναπαραγωγή βίντεο', previous: 'Προηγούμενο', next: 'Επόμενο', item: 'Μετάβαση στη διαφάνεια', pauseSlides: 'Παύση', playSlides: 'Αναπαραγωγή', carousel: 'Καρουζέλ', rating: (value: string) => `Βαθμολογία: ${value} από 5` },
  lt: { pause: 'Pristabdyti vaizdo įrašą', play: 'Paleisti vaizdo įrašą', previous: 'Ankstesnis', next: 'Kitas', item: 'Rodyti elementą', pauseSlides: 'Pristabdyti', playSlides: 'Paleisti', carousel: 'Karuselė', rating: (value: string) => `Įvertinimas: ${value} iš 5` },
  lv: { pause: 'Pauzēt video', play: 'Atskaņot video', previous: 'Iepriekšējais', next: 'Nākamais', item: 'Rādīt elementu', pauseSlides: 'Pauzēt', playSlides: 'Atskaņot', carousel: 'Karuselis', rating: (value: string) => `Vērtējums: ${value} no 5` },
  et: { pause: 'Peata video', play: 'Esita video', previous: 'Eelmine', next: 'Järgmine', item: 'Näita üksust', pauseSlides: 'Peata', playSlides: 'Esita', carousel: 'Karussell', rating: (value: string) => `Hinnang: ${value}/5` },
  is: { pause: 'Gera hlé á myndbandi', play: 'Spila myndband', previous: 'Fyrri', next: 'Næsta', item: 'Sýna', pauseSlides: 'Hlé', playSlides: 'Spila', carousel: 'Hringekja', rating: (value: string) => `Einkunn: ${value} af 5` },
  tr: { pause: 'Videoyu duraklat', play: 'Videoyu oynat', previous: 'Önceki', next: 'Sonraki', item: 'Slayt', pauseSlides: 'Duraklat', playSlides: 'Oynat', carousel: 'Slayt gösterisi', rating: (value: string) => `Puan: 5 üzerinden ${value}` },
  az: { pause: 'Videonu dayandır', play: 'Videonu oynat', previous: 'Əvvəlki', next: 'Növbəti', item: 'Slayd', pauseSlides: 'Dayandır', playSlides: 'Oynat', carousel: 'Karusel', rating: (value: string) => `Reytinq: 5 üzərindən ${value}` },
  kk: { pause: 'Бейнені кідірту', play: 'Бейнені ойнату', previous: 'Алдыңғы', next: 'Келесі', item: 'Слайд', pauseSlides: 'Кідірту', playSlides: 'Ойнату', carousel: 'Карусель', rating: (value: string) => `Рейтинг: 5-тен ${value}` },
  ka: { pause: 'ვიდეოს დაპაუზება', play: 'ვიდეოს დაკვრა', previous: 'წინა', next: 'შემდეგი', item: 'სლაიდი', pauseSlides: 'პაუზა', playSlides: 'დაკვრა', carousel: 'კარუსელი', rating: (value: string) => `შეფასება: ${value} 5-დან` },
  ar: { pause: 'إيقاف الفيديو مؤقتًا', play: 'تشغيل الفيديو', previous: 'السابق', next: 'التالي', item: 'عرض الشريحة', pauseSlides: 'إيقاف مؤقت', playSlides: 'تشغيل', carousel: 'عرض شرائح', rating: (value: string) => `التقييم: ${value} من 5` },
  he: { pause: 'השהיית הסרטון', play: 'הפעלת הסרטון', previous: 'הקודם', next: 'הבא', item: 'מעבר לשקופית', pauseSlides: 'השהיה', playSlides: 'הפעלה', carousel: 'קרוסלה', rating: (value: string) => `דירוג: ${value} מתוך 5` },
  fa: { pause: 'مکث ویدیو', play: 'پخش ویدیو', previous: 'قبلی', next: 'بعدی', item: 'نمایش اسلاید', pauseSlides: 'مکث', playSlides: 'پخش', carousel: 'اسلایدر', rating: (value: string) => `امتیاز: ${value} از 5` },
  ur: { pause: 'ویڈیو روکیں', play: 'ویڈیو چلائیں', previous: 'پچھلا', next: 'اگلا', item: 'سلائیڈ', pauseSlides: 'روکیں', playSlides: 'چلائیں', carousel: 'کیروسل', rating: (value: string) => `ریٹنگ: 5 میں سے ${value}` },
  hi: { pause: 'वीडियो रोकें', play: 'वीडियो चलाएँ', previous: 'पिछला', next: 'अगला', item: 'आइटम', pauseSlides: 'रोकें', playSlides: 'चलाएँ', carousel: 'कैरूसेल', rating: (value: string) => `रेटिंग: 5 में से ${value}` },
  bn: { pause: 'ভিডিও থামান', play: 'ভিডিও চালান', previous: 'পূর্ববর্তী', next: 'পরবর্তী', item: 'স্লাইড', pauseSlides: 'থামান', playSlides: 'চালান', carousel: 'ক্যারোসেল', rating: (value: string) => `রেটিং: 5-এর মধ্যে ${value}` },
  ta: { pause: 'வீடியோவை இடைநிறுத்து', play: 'வீடியோவை இயக்கு', previous: 'முந்தையது', next: 'அடுத்தது', item: 'ஸ்லைடு', pauseSlides: 'இடைநிறுத்து', playSlides: 'இயக்கு', carousel: 'கரோசல்', rating: (value: string) => `மதிப்பீடு: 5-க்கு ${value}` },
  th: { pause: 'หยุดวิดีโอชั่วคราว', play: 'เล่นวิดีโอ', previous: 'ก่อนหน้า', next: 'ถัดไป', item: 'สไลด์ที่', pauseSlides: 'หยุดชั่วคราว', playSlides: 'เล่น', carousel: 'ภาพสไลด์', rating: (value: string) => `คะแนน: ${value} จาก 5` },
  vi: { pause: 'Tạm dừng video', play: 'Phát video', previous: 'Trước', next: 'Tiếp theo', item: 'Xem mục', pauseSlides: 'Tạm dừng', playSlides: 'Phát', carousel: 'Trình chiếu', rating: (value: string) => `Đánh giá: ${value} trên 5` },
  id: { pause: 'Jeda video', play: 'Putar video', previous: 'Sebelumnya', next: 'Berikutnya', item: 'Tampilkan slide', pauseSlides: 'Jeda', playSlides: 'Putar', carousel: 'Korsel', rating: (value: string) => `Penilaian: ${value} dari 5` },
  ms: { pause: 'Jeda video', play: 'Main video', previous: 'Sebelumnya', next: 'Seterusnya', item: 'Tunjukkan item', pauseSlides: 'Jeda', playSlides: 'Main', carousel: 'Karusel', rating: (value: string) => `Penilaian: ${value} daripada 5` },
  ja: { pause: '動画を一時停止', play: '動画を再生', previous: '前へ', next: '次へ', item: 'スライド', pauseSlides: '一時停止', playSlides: '再生', carousel: 'カルーセル', rating: (value: string) => `評価：5点中${value}点` },
  ko: { pause: '동영상 일시정지', play: '동영상 재생', previous: '이전', next: '다음', item: '슬라이드', pauseSlides: '일시정지', playSlides: '재생', carousel: '캐러셀', rating: (value: string) => `평점: 5점 만점에 ${value}점` },
  zh: { pause: '暂停视频', play: '播放视频', previous: '上一张', next: '下一张', item: '幻灯片', pauseSlides: '暂停', playSlides: '播放', carousel: '轮播', rating: (value: string) => `评分：${value} 分（满分 5 分）` },
  'zh-Hant': { pause: '暫停影片', play: '播放影片', previous: '上一張', next: '下一張', item: '投影片', pauseSlides: '暫停', playSlides: '播放', carousel: '輪播', rating: (value: string) => `評分：${value} 分（滿分 5 分）` },
  ca: { pause: 'Posa en pausa el vídeo', play: 'Reprodueix el vídeo', previous: 'Anterior', next: 'Següent', item: 'Mostra l\'element', pauseSlides: 'Pausa', playSlides: 'Reprodueix', carousel: 'Carrusel', rating: (value: string) => `Valoració: ${value} de 5` },
} as const;

/** http(s) or a root-relative path; anything else is not a media address. */
function mediaAddress(value: unknown): string {
  const url = String(value ?? '').trim();
  if (/^\/(?!\/)/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

const YOUTUBE = /^(?:https?:)?\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/;
const VIMEO = /^(?:https?:)?\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{4,12})(?:\/([0-9a-f]{6,20}))?/;

/** Seconds from a YouTube `t`/`start` value such as 90, 90s or 1m30s. */
function startSeconds(url: URL): number {
  const raw = url.searchParams.get('start') ?? url.searchParams.get('t') ?? '';
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!raw || !match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * The embed address for a YouTube or Vimeo page address, with the block's
 * options. YouTube uses its no-cookie host. Embedded players start muted only
 * when they autoplay, which browsers require; otherwise the visitor controls
 * sound in the player.
 */
export function providerEmbedUrl(address: string, options: { autoplay: boolean; loop: boolean; controls: boolean }): string {
  const youtube = address.match(YOUTUBE);
  if (youtube) {
    const id = youtube[1];
    const params = new URLSearchParams({ rel: '0', playsinline: '1' });
    if (options.autoplay) { params.set('autoplay', '1'); params.set('mute', '1'); }
    if (options.loop) { params.set('loop', '1'); params.set('playlist', id); }
    if (!options.controls) params.set('controls', '0');
    try { const start = startSeconds(new URL(address, 'https://www.youtube.com')); if (start) params.set('start', String(start)); } catch { /* no start time */ }
    return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  }
  const vimeo = address.match(VIMEO);
  if (vimeo) {
    const params = new URLSearchParams({ dnt: '1' });
    if (vimeo[2]) params.set('h', vimeo[2]);
    if (options.autoplay) { params.set('autoplay', '1'); params.set('muted', '1'); }
    if (options.loop) params.set('loop', '1');
    if (!options.controls) params.set('controls', '0');
    return `https://player.vimeo.com/video/${vimeo[1]}?${params}`;
  }
  return '';
}

/** The player for core/video. Empty when there is no usable address. */
export function videoPlayerHtml(data: Data): string {
  const address = mediaAddress(data.video_url);
  if (!address) return '';
  const title = String(data.title ?? '').trim() || 'Video';
  const autoplay = data.autoplay === true;
  const loop = data.loop === true;
  const controls = data.controls !== false;
  const lazy = data.lazy_load !== false;
  if (data.source === 'url') {
    const poster = mediaAddress(data.poster);
    const attrs = [
      `src="${escapeAttr(address)}"`,
      poster ? `poster="${escapeAttr(poster)}"` : '',
      controls ? 'controls' : '',
      autoplay ? 'autoplay' : '',
      // Browsers only autoplay muted video.
      autoplay || data.muted !== false ? 'muted' : '',
      loop ? 'loop' : '',
      'playsinline',
      `preload="${lazy && !autoplay ? 'none' : 'metadata'}"`,
      `aria-label="${escapeAttr(title)}"`,
    ].filter(Boolean).join(' ');
    return `<video ${attrs}></video>`;
  }
  // A YouTube or Vimeo page address becomes the embed address; an address the
  // block cannot convert is kept and left to the iframe host allowlist.
  const src = providerEmbedUrl(address, { autoplay, loop, controls }) || address;
  if (data.click_to_load === true && providerEmbedUrl(address, { autoplay, loop, controls })) {
    const poster = mediaAddress(data.poster);
    return `<a href="${escapeAttr(address)}" class="tr-video-facade" data-video-src="${escapeAttr(src)}" data-video-title="${escapeAttr(title)}" aria-label="${escapeAttr(`Load video: ${title}`)}">${poster ? `<img src="${escapeAttr(poster)}" alt="" loading="lazy" />` : ''}<span>▶ ${escapeAttr(title)}</span></a>`;
  }
  return `<iframe src="${escapeAttr(src)}" title="${escapeAttr(title)}"${lazy ? ' loading="lazy"' : ''} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';

/**
 * A hero's background video: a video file, muted and looping behind the text,
 * with the hero image as its poster and a pause button the runtime reveals.
 * YouTube and Vimeo addresses are not background videos and render nothing.
 */
export function heroVideoHtml(data: Data, language: unknown): string {
  const address = mediaAddress(data.video_url);
  if (!address || YOUTUBE.test(address) || VIMEO.test(address)) return '';
  const text = TEXT[blockUiLanguage(language)];
  const poster = mediaAddress(data.image);
  return `<video class="block-hero-video" src="${escapeAttr(address)}"${poster ? ` poster="${escapeAttr(poster)}"` : ''} autoplay muted loop playsinline preload="metadata" aria-hidden="true"></video>`
    + `<button type="button" class="block-hero-video-toggle" data-label-pause="${escapeAttr(text.pause)}" data-label-play="${escapeAttr(text.play)}" aria-label="${escapeAttr(text.pause)}" hidden>${PAUSE_ICON}</button>`;
}

/**
 * A testimonial rating (0–5) as whole stars with a matching text
 * alternative: what a sighted visitor counts and what a screen reader says
 * are the same number.
 */
export function ratingHtml(rating: unknown, language: unknown): string {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return '';
  const stars = Math.min(5, Math.round(rating));
  if (stars <= 0) return '';
  const lang = blockUiLanguage(language);
  return `<p class="block-testimonial-rating" role="img" aria-label="${escapeAttr(TEXT[lang].rating(String(stars)))}">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</p>`;
}

const ARROW_LEFT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"/></svg>';
const ARROW_RIGHT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>';

/**
 * Carousel controls, hidden until the runtime has something to control.
 * Without JavaScript the track still scrolls and these stay hidden.
 */
export function carouselControlsHtml(data: Data, count: number, language: unknown): string {
  const arrows = data.show_arrows !== false;
  const dots = data.show_dots !== false;
  const autoplay = data.autoplay === true;
  if (count < 2 || (!arrows && !dots && !autoplay)) return '';
  const text = TEXT[blockUiLanguage(language)];
  const parts: string[] = [];
  if (autoplay) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-pause data-label-pause="${escapeAttr(text.pauseSlides)}" data-label-play="${escapeAttr(text.playSlides)}" aria-label="${escapeAttr(text.pauseSlides)}">${PAUSE_ICON}</button>`);
  if (arrows) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-prev aria-label="${escapeAttr(text.previous)}">${ARROW_LEFT}</button>`);
  if (dots) {
    parts.push(`<div class="tr-carousel-dots">${Array.from({ length: Math.min(count, 50) }, (_, i) =>
      `<button type="button" class="tr-carousel-dot" data-carousel-to="${i}" aria-label="${escapeAttr(`${text.item} ${i + 1}`)}"></button>`).join('')}</div>`);
  }
  if (arrows) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-next aria-label="${escapeAttr(text.next)}">${ARROW_RIGHT}</button>`);
  return `<div class="tr-carousel-controls" hidden>${parts.join('')}</div>`;
}

export function carouselRegionLabel(language: unknown): string {
  return TEXT[blockUiLanguage(language)].carousel;
}

/** Runtime for the hero background video's pause button. */
export const HERO_VIDEO_RUNTIME = String.raw`
window.TyperollBlocks.register('core/hero', function (el) {
  var video = el.querySelector(':scope > .block-hero-video');
  var toggle = el.querySelector(':scope > .block-hero-video-toggle');
  if (!video || !toggle) return;
  // Reduced motion: CSS hides the video; stop it downloading and playing too.
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { video.removeAttribute('autoplay'); video.pause(); return; }
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  function show(paused) { toggle.setAttribute('aria-label', paused ? toggle.dataset.labelPlay : toggle.dataset.labelPause); toggle.innerHTML = paused ? PLAY : PAUSE; }
  toggle.hidden = false;
  toggle.addEventListener('click', function () {
    if (video.paused) { var played = video.play(); if (played && played.catch) played.catch(function () {}); show(false); }
    else { video.pause(); show(true); }
  });
});
`;

/** Runtime for repeater carousels: arrows, dots and autoplay with pause. */
export const CAROUSEL_RUNTIME = String.raw`
window.TyperollBlocks.register('core/repeater', function (el) {
  var track = el.querySelector(':scope > .tr-carousel-track');
  var controls = el.querySelector(':scope > .tr-carousel-controls');
  if (!track || !controls) return;
  var items = Array.prototype.slice.call(track.children);
  if (items.length < 2) return;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var prev = controls.querySelector('[data-carousel-prev]');
  var next = controls.querySelector('[data-carousel-next]');
  var pause = controls.querySelector('[data-carousel-pause]');
  var dots = Array.prototype.slice.call(controls.querySelectorAll('[data-carousel-to]'));
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  // Distances run from the start edge, so right-to-left tracks (negative
  // offsets and scrollLeft) use the same arithmetic.
  var rtl = getComputedStyle(track).direction === 'rtl';
  function position(i) { var offset = items[i].offsetLeft - items[0].offsetLeft; return rtl ? -offset : offset; }
  function maxScroll() { return track.scrollWidth - track.clientWidth; }
  function scrolled() { return Math.abs(track.scrollLeft); }
  function current() {
    var best = 0, distance = Infinity;
    for (var i = 0; i < items.length; i++) { var d = Math.abs(Math.min(position(i), maxScroll()) - scrolled()); if (d < distance - 1) { distance = d; best = i; } }
    return best;
  }
  function go(i) { var distance = Math.min(position(Math.max(0, Math.min(items.length - 1, i))), maxScroll()); track.scrollTo({ left: rtl ? -distance : distance, behavior: reduced ? 'auto' : 'smooth' }); }
  function update() {
    var at = current();
    if (prev) prev.disabled = scrolled() <= 1;
    if (next) next.disabled = scrolled() >= maxScroll() - 1;
    dots.forEach(function (dot, i) { if (i === at) dot.setAttribute('aria-current', 'true'); else dot.removeAttribute('aria-current'); });
  }
  if (prev) prev.addEventListener('click', function () { go(current() - 1); });
  if (next) next.addEventListener('click', function () { go(current() + 1); });
  dots.forEach(function (dot) { dot.addEventListener('click', function () { go(Number(dot.dataset.carouselTo)); }); });
  var frame = 0;
  track.addEventListener('scroll', function () { if (!frame) frame = requestAnimationFrame(function () { frame = 0; update(); }); }, { passive: true });
  window.addEventListener('resize', update);
  controls.hidden = false;
  update();
  // Autoplay advances every 5 s and stops while the visitor points at or
  // focuses the carousel, while the tab is hidden, after they press pause,
  // and entirely when they prefer reduced motion.
  if (!pause) return;
  if (reduced || el.dataset.carouselAutoplay !== 'true') { pause.hidden = true; return; }
  var stopped = false, hovering = false, focused = false;
  function show() { pause.setAttribute('aria-label', stopped ? pause.dataset.labelPlay : pause.dataset.labelPause); pause.innerHTML = stopped ? PLAY : PAUSE; }
  pause.addEventListener('click', function () { stopped = !stopped; show(); });
  el.addEventListener('mouseenter', function () { hovering = true; });
  el.addEventListener('mouseleave', function () { hovering = false; });
  el.addEventListener('focusin', function () { focused = true; });
  el.addEventListener('focusout', function (event) { if (!el.contains(event.relatedTarget)) focused = false; });
  setInterval(function () {
    if (stopped || hovering || focused || document.hidden || !el.isConnected) return;
    if (scrolled() >= maxScroll() - 1) go(0); else go(current() + 1);
  }, 5000);
});
`;

/** Provider connections start only after an explicit visitor action. No automatic thumbnails. */
export const VIDEO_FACADE_RUNTIME = String.raw`
window.TyperollBlocks.register('core/video', function (el) {
  var button = el.querySelector('.tr-video-facade[data-video-src]');
  if (!button) return;
  button.setAttribute('role', 'button');
  button.addEventListener('keydown', function (event) { if (event.key === ' ') { event.preventDefault(); button.click(); } });
  button.addEventListener('click', function (event) {
    event.preventDefault();
    var url;
    try { url = new URL(button.dataset.videoSrc); } catch (_) { return; }
    if (url.protocol !== 'https:' || !['www.youtube-nocookie.com','player.vimeo.com'].includes(url.hostname)) return;
    var frame = document.createElement('iframe');
    frame.tabIndex = -1; frame.src = url.href; frame.title = button.dataset.videoTitle || 'Video';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    button.replaceWith(frame); frame.focus();
  }, {once:true});
});
`;
