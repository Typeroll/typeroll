import type { CookieConsentLabels, CookieConsentSettings } from './types.js';
import { buildConsentRuntime, wrapConsentScripts } from './consent-scripts.js';
import { uiLanguage, type UiLanguage } from './ui-text.js';

/** Swedish default body text, kept for callers that predate localization. */
export const DEFAULT_COOKIE_CONSENT_TEXT =
  'Vi använder cookies för att webbplatsen ska fungera och för att förstå hur den används. Du kan välja att godkänna alla cookies, bara de nödvändiga, eller neka.';

export type CookieConsentLanguage = UiLanguage;

type ConsentStrings = Required<CookieConsentLabels> & { text: string };

const CONSENT_STRINGS: Record<CookieConsentLanguage, ConsentStrings> = {
  sv: {
    text: DEFAULT_COOKIE_CONSENT_TEXT,
    title: 'Cookies på den här webbplatsen',
    reject: 'Neka',
    necessary: 'Endast nödvändiga',
    accept_all: 'Godkänn alla',
    privacy_link: 'Läs vår integritetspolicy →',
    manage: 'Hantera cookie-inställningar',
    manage_button: 'Cookies',
  },
  de: {
    text: 'Wir verwenden Cookies, damit die Website funktioniert und um zu verstehen, wie sie genutzt wird. Sie können alle Cookies akzeptieren, nur die notwendigen zulassen oder ablehnen.',
    title: 'Cookies auf dieser Website',
    reject: 'Ablehnen',
    necessary: 'Nur notwendige',
    accept_all: 'Alle akzeptieren',
    privacy_link: 'Datenschutzerklärung lesen →',
    manage: 'Cookie-Einstellungen verwalten',
    manage_button: 'Cookies',
  },
  nl: {
    text: 'We gebruiken cookies om deze website te laten werken en om te begrijpen hoe die wordt gebruikt. Je kunt alle cookies accepteren, alleen de noodzakelijke toestaan of weigeren.',
    title: 'Cookies op deze website',
    reject: 'Weigeren',
    necessary: 'Alleen noodzakelijke',
    accept_all: 'Alles accepteren',
    privacy_link: 'Lees ons privacybeleid →',
    manage: 'Cookie-instellingen beheren',
    manage_button: 'Cookies',
  },
  nb: {
    text: 'Vi bruker informasjonskapsler for at nettstedet skal fungere og for å forstå hvordan det brukes. Du kan godta alle informasjonskapsler, bare de nødvendige, eller avslå.',
    title: 'Informasjonskapsler på dette nettstedet',
    reject: 'Avslå',
    necessary: 'Bare nødvendige',
    accept_all: 'Godta alle',
    privacy_link: 'Les personvernerklæringen vår →',
    manage: 'Administrer innstillinger for informasjonskapsler',
    manage_button: 'Cookies',
  },
  fi: {
    text: 'Käytämme evästeitä, jotta sivusto toimii ja jotta ymmärrämme, miten sitä käytetään. Voit hyväksyä kaikki evästeet, sallia vain välttämättömät tai kieltäytyä.',
    title: 'Evästeet tällä sivustolla',
    reject: 'Hylkää',
    necessary: 'Vain välttämättömät',
    accept_all: 'Hyväksy kaikki',
    privacy_link: 'Lue tietosuojaselosteemme →',
    manage: 'Hallitse evästeasetuksia',
    manage_button: 'Evästeet',
  },
  fr: {
    text: 'Nous utilisons des cookies pour faire fonctionner ce site et comprendre comment il est utilisé. Vous pouvez accepter tous les cookies, n’autoriser que les cookies nécessaires ou les refuser.',
    title: 'Cookies sur ce site',
    reject: 'Refuser',
    necessary: 'Nécessaires uniquement',
    accept_all: 'Tout accepter',
    privacy_link: 'Lire notre politique de confidentialité →',
    manage: 'Gérer les paramètres des cookies',
    manage_button: 'Cookies',
  },
  pl: {
    text: 'Używamy plików cookie, aby strona działała i aby zrozumieć, jak jest używana. Możesz zaakceptować wszystkie pliki cookie, zezwolić tylko na niezbędne lub odmówić.',
    title: 'Pliki cookie na tej stronie',
    reject: 'Odrzuć',
    necessary: 'Tylko niezbędne',
    accept_all: 'Zaakceptuj wszystkie',
    privacy_link: 'Przeczytaj naszą politykę prywatności →',
    manage: 'Zarządzaj ustawieniami plików cookie',
    manage_button: 'Cookies',
  },
  it: {
    text: 'Utilizziamo i cookie per far funzionare questo sito e per capire come viene utilizzato. Puoi accettare tutti i cookie, consentire solo quelli necessari o rifiutarli.',
    title: 'Cookie su questo sito',
    reject: 'Rifiuta',
    necessary: 'Solo necessari',
    accept_all: 'Accetta tutti',
    privacy_link: 'Leggi la nostra informativa sulla privacy →',
    manage: 'Gestisci le impostazioni dei cookie',
    manage_button: 'Cookie',
  },
  es: {
    text: 'Usamos cookies para que este sitio web funcione y para entender cómo se utiliza. Puedes aceptar todas las cookies, permitir solo las necesarias o rechazarlas.',
    title: 'Cookies en este sitio web',
    reject: 'Rechazar',
    necessary: 'Solo necesarias',
    accept_all: 'Aceptar todas',
    privacy_link: 'Lee nuestra política de privacidad →',
    manage: 'Gestionar la configuración de cookies',
    manage_button: 'Cookies',
  },
  da: {
    text: 'Vi bruger cookies for at få hjemmesiden til at fungere og for at forstå, hvordan den bliver brugt. Du kan acceptere alle cookies, kun tillade de nødvendige eller afvise.',
    title: 'Cookies på denne hjemmeside',
    reject: 'Afvis',
    necessary: 'Kun nødvendige',
    accept_all: 'Accepter alle',
    privacy_link: 'Læs vores privatlivspolitik →',
    manage: 'Administrer cookieindstillinger',
    manage_button: 'Cookies',
  },
  pt: {
    text: 'Utilizamos cookies para garantir o funcionamento deste site e compreender como é utilizado. Escolha entre aceitar todos os cookies, permitir apenas os necessários ou recusar.',
    title: 'Cookies neste site',
    reject: 'Recusar',
    necessary: 'Apenas necessários',
    accept_all: 'Aceitar todos',
    privacy_link: 'Leia a nossa política de privacidade →',
    manage: 'Preferências de cookies',
    manage_button: 'Cookies',
  },
  ru: {
    text: 'Мы используем файлы cookie, чтобы сайт работал, и чтобы понимать, как им пользуются. Вы можете принять все файлы cookie, разрешить только необходимые или отказаться.',
    title: 'Файлы cookie на этом сайте',
    reject: 'Отклонить',
    necessary: 'Только необходимые',
    accept_all: 'Принять все',
    privacy_link: 'Ознакомиться с политикой конфиденциальности →',
    manage: 'Настройки файлов cookie',
    manage_button: 'Cookie',
  },
  uk: {
    text: 'Ми використовуємо файли cookie, щоб забезпечити роботу цього вебсайту й розуміти, як ним користуються. Ви можете прийняти всі файли cookie, дозволити лише необхідні або відхилити їх.',
    title: 'Файли cookie на цьому вебсайті',
    reject: 'Відхилити',
    necessary: 'Лише необхідні',
    accept_all: 'Прийняти всі',
    privacy_link: 'Ознайомитися з політикою конфіденційності →',
    manage: 'Керувати налаштуваннями файлів cookie',
    manage_button: 'Файли cookie',
  },
  cs: {
    text: 'Používáme soubory cookie, aby tento web fungoval a abychom rozuměli tomu, jak se používá. Můžete přijmout všechny soubory cookie, povolit jen nezbytné, nebo je odmítnout.',
    title: 'Soubory cookie na tomto webu',
    reject: 'Odmítnout',
    necessary: 'Jen nezbytné',
    accept_all: 'Přijmout vše',
    privacy_link: 'Přečtěte si zásady ochrany osobních údajů →',
    manage: 'Spravovat nastavení souborů cookie',
    manage_button: 'Cookies',
  },
  sk: {
    text: 'Používame súbory cookie, aby táto webová stránka fungovala a aby sme rozumeli, ako sa používa. Môžete prijať všetky súbory cookie, povoliť len nevyhnutné alebo ich odmietnuť.',
    title: 'Súbory cookie na tejto webovej stránke',
    reject: 'Odmietnuť',
    necessary: 'Len nevyhnutné',
    accept_all: 'Prijať všetky',
    privacy_link: 'Prečítajte si zásady ochrany osobných údajov →',
    manage: 'Spravovať nastavenia súborov cookie',
    manage_button: 'Cookies',
  },
  hu: {
    text: 'Sütiket használunk a weboldal működéséhez, és hogy megértsük, hogyan használják. Elfogadhatja az összes sütit, engedélyezheti csak a szükségeseket, vagy elutasíthatja őket.',
    title: 'Sütik ezen a weboldalon',
    reject: 'Elutasítás',
    necessary: 'Csak a szükségesek',
    accept_all: 'Összes elfogadása',
    privacy_link: 'Olvassa el adatkezelési tájékoztatónkat →',
    manage: 'Sütibeállítások kezelése',
    manage_button: 'Sütik',
  },
  ro: {
    text: 'Folosim cookie-uri pentru ca acest site să funcționeze și pentru a înțelege cum este utilizat. Puteți accepta toate cookie-urile, le puteți permite doar pe cele necesare sau le puteți refuza.',
    title: 'Cookie-uri pe acest site',
    reject: 'Refuz',
    necessary: 'Doar cele necesare',
    accept_all: 'Accept toate',
    privacy_link: 'Citiți politica noastră de confidențialitate →',
    manage: 'Gestionați setările pentru cookie-uri',
    manage_button: 'Cookie-uri',
  },
  bg: {
    text: 'Използваме бисквитки, за да работи този уебсайт и за да разберем как се използва. Можете да приемете всички бисквитки, да разрешите само необходимите или да откажете.',
    title: 'Бисквитки на този уебсайт',
    reject: 'Отхвърли',
    necessary: 'Само необходимите',
    accept_all: 'Приеми всички',
    privacy_link: 'Прочетете нашата политика за поверителност →',
    manage: 'Управление на настройките за бисквитки',
    manage_button: 'Бисквитки',
  },
  hr: {
    text: 'Koristimo kolačiće kako bi ova web-stranica radila i kako bismo razumjeli kako se koristi. Možete prihvatiti sve kolačiće, dopustiti samo nužne ili ih odbiti.',
    title: 'Kolačići na ovoj web-stranici',
    reject: 'Odbij',
    necessary: 'Samo nužni',
    accept_all: 'Prihvati sve',
    privacy_link: 'Pročitajte našu politiku privatnosti →',
    manage: 'Upravljanje postavkama kolačića',
    manage_button: 'Kolačići',
  },
  sr: {
    text: 'Користимо колачиће да би овај веб-сајт функционисао и да бисмо разумели како се користи. Можете прихватити све колачиће, дозволити само неопходне или их одбити.',
    title: 'Колачићи на овом веб-сајту',
    reject: 'Одбиј',
    necessary: 'Само неопходни',
    accept_all: 'Прихвати све',
    privacy_link: 'Прочитајте нашу политику приватности →',
    manage: 'Управљање подешавањима колачића',
    manage_button: 'Колачићи',
  },
  bs: {
    text: 'Koristimo kolačiće kako bi ova web stranica radila i kako bismo razumjeli kako se koristi. Možete prihvatiti sve kolačiće, dozvoliti samo neophodne ili ih odbiti.',
    title: 'Kolačići na ovoj web stranici',
    reject: 'Odbij',
    necessary: 'Samo neophodni',
    accept_all: 'Prihvati sve',
    privacy_link: 'Pročitajte našu politiku privatnosti →',
    manage: 'Upravljaj postavkama kolačića',
    manage_button: 'Kolačići',
  },
  sl: {
    text: 'Piškotke uporabljamo za delovanje tega spletnega mesta in za razumevanje, kako se uporablja. Sprejmete lahko vse piškotke, dovolite samo nujne ali jih zavrnete.',
    title: 'Piškotki na tem spletnem mestu',
    reject: 'Zavrni',
    necessary: 'Samo nujni',
    accept_all: 'Sprejmi vse',
    privacy_link: 'Preberite našo politiko zasebnosti →',
    manage: 'Upravljanje nastavitev piškotkov',
    manage_button: 'Piškotki',
  },
  mk: {
    text: 'Користиме колачиња за да функционира веб-страницата и за да разбереме како се користи. Може да ги прифатите сите колачиња, да ги дозволите само неопходните или да ги одбиете.',
    title: 'Колачиња на оваа веб-страница',
    reject: 'Одбиј',
    necessary: 'Само неопходни',
    accept_all: 'Прифати ги сите',
    privacy_link: 'Прочитајте ја нашата политика за приватност →',
    manage: 'Управувај со поставките за колачиња',
    manage_button: 'Колачиња',
  },
  sq: {
    text: 'Ne përdorim cookies që kjo faqe interneti të funksionojë dhe për të kuptuar se si përdoret. Mund t\'i pranoni të gjitha cookies, të lejoni vetëm ato të nevojshme ose t\'i refuzoni.',
    title: 'Cookies në këtë faqe interneti',
    reject: 'Refuzo',
    necessary: 'Vetëm të nevojshmet',
    accept_all: 'Prano të gjitha',
    privacy_link: 'Lexoni politikën tonë të privatësisë →',
    manage: 'Menaxho cilësimet e cookies',
    manage_button: 'Cookies',
  },
  el: {
    text: 'Χρησιμοποιούμε cookies για τη λειτουργία αυτού του ιστότοπου και για να κατανοούμε πώς χρησιμοποιείται. Μπορείτε να αποδεχτείτε όλα τα cookies, να επιτρέψετε μόνο τα απαραίτητα ή να τα απορρίψετε.',
    title: 'Cookies σε αυτόν τον ιστότοπο',
    reject: 'Απόρριψη',
    necessary: 'Μόνο τα απαραίτητα',
    accept_all: 'Αποδοχή όλων',
    privacy_link: 'Διαβάστε την πολιτική απορρήτου μας →',
    manage: 'Διαχείριση ρυθμίσεων cookies',
    manage_button: 'Cookies',
  },
  lt: {
    text: 'Naudojame slapukus, kad ši svetainė veiktų ir kad suprastume, kaip ja naudojamasi. Galite priimti visus slapukus, leisti tik būtinuosius arba atsisakyti.',
    title: 'Slapukai šioje svetainėje',
    reject: 'Atsisakyti',
    necessary: 'Tik būtinieji',
    accept_all: 'Priimti visus',
    privacy_link: 'Skaitykite mūsų privatumo politiką →',
    manage: 'Tvarkyti slapukų nustatymus',
    manage_button: 'Slapukai',
  },
  lv: {
    text: 'Mēs izmantojam sīkdatnes, lai šī tīmekļa vietne darbotos un lai saprastu, kā tā tiek izmantota. Varat pieņemt visas sīkdatnes, atļaut tikai nepieciešamās vai atteikties.',
    title: 'Sīkdatnes šajā tīmekļa vietnē',
    reject: 'Atteikties',
    necessary: 'Tikai nepieciešamās',
    accept_all: 'Pieņemt visas',
    privacy_link: 'Izlasiet mūsu privātuma politiku →',
    manage: 'Pārvaldīt sīkdatņu iestatījumus',
    manage_button: 'Sīkdatnes',
  },
  et: {
    text: 'Kasutame küpsiseid, et see veebisait töötaks ja et mõista, kuidas seda kasutatakse. Võite nõustuda kõigi küpsistega, lubada ainult vajalikud või keelduda.',
    title: 'Küpsised sellel veebisaidil',
    reject: 'Keeldu',
    necessary: 'Ainult vajalikud',
    accept_all: 'Nõustu kõigiga',
    privacy_link: 'Loe meie privaatsuspoliitikat →',
    manage: 'Halda küpsiste seadeid',
    manage_button: 'Küpsised',
  },
  is: {
    text: 'Við notum vafrakökur til að vefsíðan virki og til að skilja hvernig hún er notuð. Þú getur samþykkt allar vafrakökur, leyft aðeins nauðsynlegar eða hafnað þeim.',
    title: 'Vafrakökur á þessum vef',
    reject: 'Hafna',
    necessary: 'Aðeins nauðsynlegar',
    accept_all: 'Samþykkja allar',
    privacy_link: 'Lestu persónuverndarstefnu okkar →',
    manage: 'Stjórna stillingum vafrakaka',
    manage_button: 'Vafrakökur',
  },
  tr: {
    text: 'Bu web sitesinin çalışmasını sağlamak ve nasıl kullanıldığını anlamak için çerezler kullanıyoruz. Tüm çerezleri kabul edebilir, yalnızca gerekli olanlara izin verebilir veya reddedebilirsiniz.',
    title: 'Bu web sitesinde çerez kullanımı',
    reject: 'Reddet',
    necessary: 'Yalnızca gerekli',
    accept_all: 'Tümünü kabul et',
    privacy_link: 'Gizlilik politikamızı okuyun →',
    manage: 'Çerez ayarlarını yönet',
    manage_button: 'Çerezler',
  },
  az: {
    text: 'Bu veb-saytın işləməsi və onun necə istifadə olunduğunu anlamaq üçün kukilərdən istifadə edirik. Bütün kukiləri qəbul edə, yalnız zəruri olanlara icazə verə və ya imtina edə bilərsiniz.',
    title: 'Bu veb-saytda kukilər',
    reject: 'İmtina et',
    necessary: 'Yalnız zəruri',
    accept_all: 'Hamısını qəbul et',
    privacy_link: 'Məxfilik siyasətimizi oxuyun →',
    manage: 'Kuki ayarlarını idarə et',
    manage_button: 'Kukilər',
  },
  kk: {
    text: 'Біз сайттың жұмыс істеуі және оның қалай пайдаланылатынын түсіну үшін cookie файлдарын қолданамыз. Барлық cookie файлдарын қабылдай, тек қажеттілеріне рұқсат бере немесе бас тарта аласыз.',
    title: 'Бұл сайттағы cookie файлдары',
    reject: 'Бас тарту',
    necessary: 'Тек қажеттілері',
    accept_all: 'Барлығын қабылдау',
    privacy_link: 'Құпиялық саясатымызбен танысыңыз →',
    manage: 'Cookie баптауларын басқару',
    manage_button: 'Cookie',
  },
  ka: {
    text: 'ჩვენ ვიყენებთ ქუქი-ფაილებს, რათა ვებსაიტმა იმუშაოს და გავიგოთ, როგორ გამოიყენება ის. შეგიძლიათ მიიღოთ ყველა ქუქი-ფაილი, დაუშვათ მხოლოდ აუცილებელი ან უარი თქვათ.',
    title: 'ქუქი-ფაილები ამ ვებსაიტზე',
    reject: 'უარყოფა',
    necessary: 'მხოლოდ აუცილებელი',
    accept_all: 'ყველას მიღება',
    privacy_link: 'გაეცანით ჩვენს კონფიდენციალურობის პოლიტიკას →',
    manage: 'ქუქი-ფაილების პარამეტრების მართვა',
    manage_button: 'ქუქი-ფაილები',
  },
  ar: {
    text: 'نستخدم ملفات تعريف الارتباط لكي يعمل هذا الموقع ولفهم كيفية استخدامه. يمكنك قبول جميع ملفات تعريف الارتباط، أو السماح بالضرورية منها فقط، أو رفضها.',
    title: 'ملفات تعريف الارتباط على هذا الموقع',
    reject: 'رفض',
    necessary: 'الضرورية فقط',
    accept_all: 'قبول الكل',
    privacy_link: 'اطّلع على سياسة الخصوصية ←',
    manage: 'إدارة إعدادات ملفات تعريف الارتباط',
    manage_button: 'الكوكيز',
  },
  he: {
    text: 'אנחנו משתמשים בעוגיות כדי שהאתר יפעל וכדי להבין איך משתמשים בו. אפשר לאשר את כל העוגיות, לאפשר רק את ההכרחיות או לדחות אותן.',
    title: 'עוגיות באתר',
    reject: 'דחייה',
    necessary: 'הכרחיות בלבד',
    accept_all: 'אישור הכול',
    privacy_link: 'למדיניות הפרטיות שלנו ←',
    manage: 'ניהול הגדרות עוגיות',
    manage_button: 'עוגיות',
  },
  fa: {
    text: 'ما از کوکی‌ها استفاده می‌کنیم تا این وب‌سایت به‌درستی کار کند و بفهمیم چگونه از آن استفاده می‌شود. می‌توانید همه کوکی‌ها را بپذیرید، فقط کوکی‌های ضروری را مجاز کنید یا آن‌ها را رد کنید.',
    title: 'کوکی‌ها در این وب‌سایت',
    reject: 'رد کردن',
    necessary: 'فقط ضروری',
    accept_all: 'پذیرش همه',
    privacy_link: 'سیاست حفظ حریم خصوصی ما را بخوانید ←',
    manage: 'مدیریت تنظیمات کوکی',
    manage_button: 'کوکی‌ها',
  },
  ur: {
    text: 'ہم یہ ویب سائٹ چلانے اور یہ سمجھنے کے لیے کوکیز استعمال کرتے ہیں کہ اسے کیسے استعمال کیا جاتا ہے۔ آپ تمام کوکیز قبول کر سکتے ہیں، صرف ضروری کوکیز کی اجازت دے سکتے ہیں، یا انکار کر سکتے ہیں۔',
    title: 'اس ویب سائٹ پر کوکیز',
    reject: 'مسترد کریں',
    necessary: 'صرف ضروری',
    accept_all: 'سب قبول کریں',
    privacy_link: 'ہماری رازداری کی پالیسی پڑھیں ←',
    manage: 'کوکی کی ترتیبات کا نظم کریں',
    manage_button: 'کوکیز',
  },
  hi: {
    text: 'हम इस वेबसाइट को चलाने और यह समझने के लिए कुकीज़ का उपयोग करते हैं कि इसका उपयोग कैसे होता है। आप सभी कुकीज़ स्वीकार कर सकते हैं, केवल ज़रूरी कुकीज़ की अनुमति दे सकते हैं या उन्हें अस्वीकार कर सकते हैं।',
    title: 'इस वेबसाइट पर कुकीज़',
    reject: 'अस्वीकार करें',
    necessary: 'केवल ज़रूरी',
    accept_all: 'सभी स्वीकार करें',
    privacy_link: 'हमारी गोपनीयता नीति पढ़ें →',
    manage: 'कुकी सेटिंग्स प्रबंधित करें',
    manage_button: 'कुकीज़',
  },
  bn: {
    text: 'এই ওয়েবসাইটটি সচল রাখতে এবং এটি কীভাবে ব্যবহৃত হয় তা বুঝতে আমরা কুকি ব্যবহার করি। আপনি সব কুকি গ্রহণ করতে পারেন, শুধু প্রয়োজনীয়গুলোর অনুমতি দিতে পারেন, অথবা প্রত্যাখ্যান করতে পারেন।',
    title: 'এই ওয়েবসাইটে কুকি',
    reject: 'প্রত্যাখ্যান করুন',
    necessary: 'শুধু প্রয়োজনীয়',
    accept_all: 'সব গ্রহণ করুন',
    privacy_link: 'আমাদের গোপনীয়তা নীতি পড়ুন →',
    manage: 'কুকি সেটিংস পরিচালনা করুন',
    manage_button: 'কুকি',
  },
  ta: {
    text: 'இந்த இணையதளம் செயல்படவும், அது எவ்வாறு பயன்படுத்தப்படுகிறது என்பதைப் புரிந்துகொள்ளவும் நாங்கள் குக்கீகளைப் பயன்படுத்துகிறோம். நீங்கள் எல்லா குக்கீகளையும் ஏற்கலாம், தேவையானவற்றை மட்டும் அனுமதிக்கலாம் அல்லது நிராகரிக்கலாம்.',
    title: 'இந்த இணையதளத்தில் குக்கீகள்',
    reject: 'நிராகரிக்கவும்',
    necessary: 'தேவையானவை மட்டும்',
    accept_all: 'அனைத்தையும் ஏற்கவும்',
    privacy_link: 'எங்கள் தனியுரிமைக் கொள்கையைப் படிக்கவும் →',
    manage: 'குக்கீ அமைப்புகளை நிர்வகிக்கவும்',
    manage_button: 'குக்கீகள்',
  },
  th: {
    text: 'เราใช้คุกกี้เพื่อให้เว็บไซต์นี้ทำงานได้และเพื่อทำความเข้าใจว่ามีการใช้งานเว็บไซต์อย่างไร คุณสามารถยอมรับคุกกี้ทั้งหมด อนุญาตเฉพาะคุกกี้ที่จำเป็น หรือปฏิเสธได้',
    title: 'เว็บไซต์นี้ใช้คุกกี้',
    reject: 'ปฏิเสธ',
    necessary: 'เฉพาะที่จำเป็น',
    accept_all: 'ยอมรับทั้งหมด',
    privacy_link: 'อ่านนโยบายความเป็นส่วนตัว →',
    manage: 'จัดการการตั้งค่าคุกกี้',
    manage_button: 'คุกกี้',
  },
  vi: {
    text: 'Chúng tôi sử dụng cookie để trang web hoạt động và để hiểu cách trang web được sử dụng. Bạn có thể chấp nhận tất cả cookie, chỉ cho phép cookie cần thiết hoặc từ chối.',
    title: 'Cookie trên trang web này',
    reject: 'Từ chối',
    necessary: 'Chỉ cookie cần thiết',
    accept_all: 'Chấp nhận tất cả',
    privacy_link: 'Đọc chính sách quyền riêng tư của chúng tôi →',
    manage: 'Quản lý cài đặt cookie',
    manage_button: 'Cookie',
  },
  id: {
    text: 'Kami menggunakan cookie agar situs web ini berfungsi dan untuk memahami cara situs ini digunakan. Anda dapat menerima semua cookie, hanya mengizinkan cookie yang diperlukan, atau menolaknya.',
    title: 'Cookie di situs web ini',
    reject: 'Tolak',
    necessary: 'Hanya yang diperlukan',
    accept_all: 'Terima semua',
    privacy_link: 'Baca kebijakan privasi kami →',
    manage: 'Kelola pengaturan cookie',
    manage_button: 'Cookie',
  },
  ms: {
    text: 'Kami menggunakan kuki untuk memastikan laman web ini berfungsi dan untuk memahami cara ia digunakan. Anda boleh menerima semua kuki, membenarkan kuki yang perlu sahaja atau menolak.',
    title: 'Kuki di laman web ini',
    reject: 'Tolak',
    necessary: 'Hanya yang perlu',
    accept_all: 'Terima semua',
    privacy_link: 'Baca dasar privasi kami →',
    manage: 'Urus tetapan kuki',
    manage_button: 'Kuki',
  },
  ja: {
    text: '当サイトでは、サイトを正しく機能させ、利用状況を把握するためにCookieを使用しています。すべてのCookieを許可するか、必要なCookieのみを許可するか、拒否するかを選択できます。',
    title: '当サイトのCookieについて',
    reject: '拒否する',
    necessary: '必要なCookieのみ',
    accept_all: 'すべて許可する',
    privacy_link: 'プライバシーポリシーを見る →',
    manage: 'Cookie設定を管理',
    manage_button: 'Cookie',
  },
  ko: {
    text: '이 웹사이트는 사이트 운영과 이용 현황 파악을 위해 쿠키를 사용합니다. 모든 쿠키를 허용하거나, 필수 쿠키만 허용하거나, 거부할 수 있습니다.',
    title: '쿠키 사용 안내',
    reject: '거부',
    necessary: '필수 쿠키만 허용',
    accept_all: '모두 허용',
    privacy_link: '개인정보 처리방침 보기 →',
    manage: '쿠키 설정 관리',
    manage_button: '쿠키',
  },
  zh: {
    text: '我们使用 Cookie 来确保本网站正常运行，并了解网站的使用情况。您可以接受所有 Cookie、仅允许必要的 Cookie，或全部拒绝。',
    title: '本网站使用 Cookie',
    reject: '拒绝',
    necessary: '仅限必要 Cookie',
    accept_all: '全部接受',
    privacy_link: '阅读我们的隐私政策 →',
    manage: '管理 Cookie 设置',
    manage_button: 'Cookie',
  },
  'zh-Hant': {
    text: '我們使用 Cookie 來維持本網站正常運作，並了解網站的使用情形。您可以接受所有 Cookie、僅允許必要的 Cookie，或全部拒絕。',
    title: '本網站使用 Cookie',
    reject: '拒絕',
    necessary: '僅限必要 Cookie',
    accept_all: '全部接受',
    privacy_link: '閱讀我們的隱私權政策 →',
    manage: '管理 Cookie 設定',
    manage_button: 'Cookie',
  },
  ca: {
    text: 'Utilitzem galetes perquè aquest lloc web funcioni i per entendre com s\'utilitza. Podeu acceptar totes les galetes, permetre només les necessàries o rebutjar-les.',
    title: 'Galetes en aquest lloc web',
    reject: 'Rebutja',
    necessary: 'Només les necessàries',
    accept_all: 'Accepta-les totes',
    privacy_link: 'Llegiu la nostra política de privadesa →',
    manage: 'Gestiona la configuració de galetes',
    manage_button: 'Galetes',
  },
  en: {
    text: 'We use cookies to make this website work and to understand how it is used. You can accept all cookies, allow only the necessary ones, or decline.',
    title: 'Cookies on this website',
    reject: 'Decline',
    necessary: 'Necessary only',
    accept_all: 'Accept all',
    privacy_link: 'Read our privacy policy →',
    manage: 'Manage cookie settings',
    manage_button: 'Cookies',
  },
};

/** Built-in banner language for a BCP 47 tag (ui-text.ts UI_LANGUAGES), otherwise English. */
export function cookieConsentLanguage(language: unknown): CookieConsentLanguage {
  return uiLanguage(language);
}

/** Default body text shown when the site has not written its own. */
export function cookieConsentDefaultText(language: unknown): string {
  return CONSENT_STRINGS[cookieConsentLanguage(language)].text;
}

export const COOKIE_CONSENT_LABEL_KEYS = [
  'title', 'reject', 'necessary', 'accept_all', 'privacy_link', 'manage', 'manage_button',
] as const;
export const COOKIE_CONSENT_LABEL_MAX_LENGTH = 120;

/**
 * Validate cookie_consent.labels from an API or form write. Values are plain
 * text; blank values are dropped so the built-in wording applies.
 */
export function normalizeCookieConsentLabels(value: unknown): { labels?: CookieConsentLabels; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'cookie_consent.labels must be an object' };
  const allowed = new Set<string>(COOKIE_CONSENT_LABEL_KEYS);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown cookie_consent.labels fields: ${unknown.join(', ')}` };
  const labels: CookieConsentLabels = {};
  for (const key of COOKIE_CONSENT_LABEL_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { error: `cookie_consent.labels.${key} must be a string` };
    const text = raw.trim();
    if (text.length > COOKIE_CONSENT_LABEL_MAX_LENGTH) {
      return { error: `cookie_consent.labels.${key} must be at most ${COOKIE_CONSENT_LABEL_MAX_LENGTH} characters` };
    }
    if (text) labels[key] = text;
  }
  return Object.keys(labels).length ? { labels } : {};
}

function consentLabels(consent: CookieConsentSettings, language: unknown): ConsentStrings {
  const defaults = CONSENT_STRINGS[cookieConsentLanguage(language)];
  const custom = consent.labels ?? {};
  const pick = (key: keyof CookieConsentLabels) => {
    const value = custom[key];
    return typeof value === 'string' && value.trim() ? value.trim() : defaults[key];
  };
  return {
    text: defaults.text,
    title: pick('title'),
    reject: pick('reject'),
    necessary: pick('necessary'),
    accept_all: pick('accept_all'),
    privacy_link: pick('privacy_link'),
    manage: pick('manage'),
    manage_button: pick('manage_button'),
  };
}

export const COOKIE_CONSENT_STYLES = `
.tr-consent{display:none;position:fixed;inset:0;z-index:2147483000;align-items:flex-end;justify-content:center;font-family:var(--font-body),-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',sans-serif}
.tr-consent-needed .tr-consent{display:flex;animation:tr-cc-fade .3s ease-out}
.tr-consent-needed{overflow:hidden}
.tr-consent-needed body{overflow:hidden}
.tr-consent__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.32);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%)}
.tr-consent__panel{position:relative;width:100%;max-width:480px;background:rgba(255,255,255,.82);-webkit-backdrop-filter:blur(40px) saturate(200%);backdrop-filter:blur(40px) saturate(200%);border:1px solid rgba(255,255,255,.5);border-radius:24px 24px 0 0;padding:1.75rem 1.5rem calc(1.5rem + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 40px rgba(0,0,0,.18),0 1px 0 rgba(255,255,255,.45) inset;animation:tr-cc-rise .4s cubic-bezier(.16,1,.3,1)}
@media (min-width:640px){.tr-consent{align-items:center;padding:1.25rem}.tr-consent__panel{border-radius:24px;padding:2rem;animation:tr-cc-pop .35s cubic-bezier(.16,1,.3,1)}}
.tr-consent__title{font-family:var(--font-heading),sans-serif;font-size:1.25rem;font-weight:600;line-height:1.25;letter-spacing:-.01em;color:#0f172a;margin:0 0 .75rem}
.tr-consent__body{color:#334155;font-size:.9375rem;line-height:1.55;margin:0 0 1.25rem}
.tr-consent__body p{margin:0 0 .5rem}.tr-consent__body p:last-child{margin-bottom:0}
.tr-consent__body a{color:var(--color-primary);text-decoration:underline;text-underline-offset:2px}
.tr-consent__link{display:inline-block;margin:-.5rem 0 1.25rem;color:var(--color-primary);font-size:.875rem;text-decoration:underline;text-underline-offset:2px}
.tr-consent__actions{display:grid;grid-template-columns:1fr;gap:.625rem}
@media (min-width:520px){.tr-consent__actions{grid-template-columns:1fr 1fr 1.3fr}}
.tr-consent__btn{appearance:none;border:0;font:600 .9375rem/1.2 inherit;padding:.95rem 1rem;border-radius:14px;cursor:pointer;min-height:48px;transition:transform .15s ease,box-shadow .2s ease,background-color .2s ease;letter-spacing:.01em;-webkit-tap-highlight-color:transparent}
.tr-consent__btn:active{transform:scale(.97)}
.tr-consent__btn:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.tr-consent__btn--ghost{background:rgba(15,23,42,.05);color:#475569}
.tr-consent__btn--ghost:hover{background:rgba(15,23,42,.09)}
.tr-consent__btn--secondary{background:rgba(255,255,255,.7);color:#0f172a;border:1px solid rgba(15,23,42,.1);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tr-consent__btn--secondary:hover{background:#fff}
.tr-consent__btn--primary{background:var(--color-primary);background-image:linear-gradient(180deg,color-mix(in srgb,var(--color-primary) 88%,white) 0%,var(--color-primary) 100%);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08),0 6px 18px color-mix(in srgb,var(--color-primary) 32%,transparent)}
.tr-consent__btn--primary:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.1),0 10px 26px color-mix(in srgb,var(--color-primary) 42%,transparent)}
.tr-consent__handle{display:block;width:36px;height:5px;border-radius:999px;background:rgba(15,23,42,.18);margin:-.5rem auto 1rem}
@media (min-width:640px){.tr-consent__handle{display:none}}
.tr-consent__manage{appearance:none;border:0;cursor:pointer;position:fixed;bottom:1rem;left:1rem;z-index:2147482999;display:inline-flex;align-items:center;gap:.4rem;background:rgba(15,23,42,.72);color:#fff;font:500 .75rem/1 -apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',sans-serif;padding:.5rem .8rem;border-radius:999px;text-decoration:none;-webkit-backdrop-filter:blur(12px) saturate(160%);backdrop-filter:blur(12px) saturate(160%);box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:.78;transition:opacity .2s ease,transform .15s ease;padding-bottom:calc(.5rem + env(safe-area-inset-bottom,0px))}
.tr-consent__manage:hover{opacity:1;transform:translateY(-1px)}
.tr-consent__manage:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.tr-consent__manage svg{width:14px;height:14px}
.tr-consent-needed .tr-consent__manage{display:none}
@keyframes tr-cc-fade{from{opacity:0}to{opacity:1}}
@keyframes tr-cc-rise{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes tr-cc-pop{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
@media (prefers-color-scheme:dark){
  .tr-consent__panel{background:rgba(28,28,32,.82);border-color:rgba(255,255,255,.08);box-shadow:0 -10px 40px rgba(0,0,0,.4),0 1px 0 rgba(255,255,255,.06) inset}
  .tr-consent__title{color:#f8fafc}
  .tr-consent__body{color:#cbd5e1}
  .tr-consent__btn--ghost{background:rgba(255,255,255,.06);color:#cbd5e1}
  .tr-consent__btn--ghost:hover{background:rgba(255,255,255,.12)}
  .tr-consent__btn--secondary{background:rgba(255,255,255,.08);color:#f8fafc;border-color:rgba(255,255,255,.12)}
  .tr-consent__btn--secondary:hover{background:rgba(255,255,255,.14)}
  .tr-consent__handle{background:rgba(255,255,255,.2)}
}
@media (prefers-reduced-motion:reduce){.tr-consent,.tr-consent__panel{animation:none!important}.tr-consent__btn{transition:none}}
`;

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const escapeText = escapeAttr;

/**
 * Render the complete consent fragment shared by static output and the
 * isolated hosted preview. bodyHtml must already have passed the caller's
 * HTML sanitizer because allowed iframe hosts are site-specific. language is
 * the page's BCP 47 tag; it selects the built-in wording, which
 * consent.labels can replace per site.
 */
export function renderCookieConsent(
  consent: CookieConsentSettings | undefined,
  bodyHtml?: string,
  language?: string,
  options: { initialChoice?: 'all' | 'necessary' } = {},
): string {
  if (consent?.enabled !== true) return '';
  const labels = consentLabels(consent, language);
  const body = bodyHtml || `<p>${escapeText(labels.text)}</p>`;
  const necessary = consent.scripts_necessary ?? '';
  const optional = consent.scripts_optional
    ? wrapConsentScripts(consent.scripts_optional)
    : '';
  const privacyLink = consent.privacy_policy_url
    ? `<a class="tr-consent__link" href="${escapeAttr(consent.privacy_policy_url)}" target="_blank" rel="noopener">${escapeText(labels.privacy_link)}</a>`
    : '';

  return `${necessary}${optional}<style data-cookie-consent="1">${COOKIE_CONSENT_STYLES}</style>
<div id="tr-consent" class="tr-consent" role="dialog" aria-modal="true" aria-labelledby="tr-consent-title" aria-describedby="tr-consent-body">
  <div class="tr-consent__backdrop" aria-hidden="true"></div>
  <div class="tr-consent__panel">
    <span class="tr-consent__handle" aria-hidden="true"></span>
    <h2 id="tr-consent-title" class="tr-consent__title">${escapeText(labels.title)}</h2>
    <div id="tr-consent-body" class="tr-consent__body">${body}</div>
    ${privacyLink}
    <div class="tr-consent__actions">
      <button type="button" class="tr-consent__btn tr-consent__btn--ghost" data-tr-consent-action="rejected">${escapeText(labels.reject)}</button>
      <button type="button" class="tr-consent__btn tr-consent__btn--ghost" data-tr-consent-action="necessary">${escapeText(labels.necessary)}</button>
      <button type="button" class="tr-consent__btn tr-consent__btn--primary" data-tr-consent-action="all">${escapeText(labels.accept_all)}</button>
    </div>
  </div>
</div>
<button type="button" class="tr-consent__manage" data-tr-open-consent aria-label="${escapeAttr(labels.manage)}">
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.5" r=".9" fill="currentColor"/><circle cx="10.5" cy="7.5" r=".7" fill="currentColor"/><circle cx="7" cy="10.5" r=".8" fill="currentColor"/></svg>
  <span>${escapeText(labels.manage_button)}</span>
</button>
<script data-cookie-consent-runtime="1">${buildConsentRuntime(consent.reload_after_consent === true, options.initialChoice)}</script>`;
}
