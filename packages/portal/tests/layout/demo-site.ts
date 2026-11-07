/**
 * A realistic demo site in the standard design, with no custom CSS: an
 * architecture studio with the pages a small business has, real copy, images
 * and every core block type a page can hold. Built by the real static
 * renderer; the layout contract and screenshots read it.
 */
import {
  LATEST_RENDER_VERSION, defaultSiteSettings, getPageTemplateStarter, getPartialCompositionStarter, newSiteStyles, type Block,
} from '@typeroll/shared';
import { demoImage } from './demo-media';

let counter = 0;
const b = (type: string, data: Record<string, unknown> = {}, children?: Block[]): Block =>
  ({ id: `${type.replace(/\W+/g, '-')}-${++counter}`, type, data, ...(children ? { children } : {}) });
const section = (children: Block[], data: Record<string, unknown> = {}) => b('core/section', { width: 'wide', ...data }, children);
const heading = (text: string, data: Record<string, unknown> = {}) => b('core/heading', { text, level: 'h2', ...data });
const prose = (html: string) => b('core/prose', { html });
const button = (label: string, href: string, variant = 'primary') => b('core/button', { label, href, variant });
const columns = (data: Record<string, unknown>, [left, right]: Block[]) => ({ ...b('core/columns', data), slots: [[left!], [right!]] });
const buttons = (...items: Block[]) => b('core/container', { direction: 'row', wrap: 'wrap', gap: 'sm', width: 'full' }, items);

const LINKS = [
  { label: 'Tjänster', href: '/tjanster/' }, { label: 'Projekt', href: '/projekt/' }, { label: 'Priser', href: '/priser/' },
  { label: 'Journal', href: '/journal/' }, { label: 'Om oss', href: '/om-oss/' }, { label: 'Kontakt', href: '/kontakt/' },
];

const page = (id: string, path: string, title: string, blocks: Block[], extra: Record<string, unknown> = {}) =>
  ({ id, slug: id, path, title, status: 'published', content_mode: 'blocks', blocks, ...extra });

function home() {
  return page('home', '/', 'Ljusrum Arkitekter', [
    b('core/hero', {
      eyebrow: 'Arkitektkontor i Umeå', heading: 'Hus som tar vara på ljuset',
      subheading: '<p>Vi ritar bostäder, skolor och arbetsplatser i norr, där dagsljuset är kort på vintern och nästan oändligt på sommaren.</p>',
      primary_label: 'Se våra projekt', primary_url: '/projekt/', secondary_label: 'Boka ett första möte', secondary_url: '/kontakt/',
      image: demoImage('hero'), layout: 'split-right', width: 'wide',
    }),
    section([
      b('core/text', { text: 'Uppdragsgivare vi har arbetat med', align: 'center' }),
      b('core/logo_cloud', { layout: 'marquee', items: [1, 2, 3, 4, 5, 6].map(n => ({ src: demoImage(`logo-${n}` as never), alt: ['Nordbygg', 'Ljusvik', 'Stråla', 'Kvarnen', 'Bergsand', 'Ekhagen'][n - 1] })) }),
    ]),
    section([
      b('core/stats', { motion: 'fade', items: [
        { value: '140', label: 'Ritade hus' }, { value: '17', label: 'År i Umeå' },
        { value: '96 %', label: 'Kunder som rekommenderar oss', description: 'Enkät 2026' }, { value: '2 400', label: 'Kvadratmeter om året' },
      ] }),
    ]),
    section([
      heading('Ljuset i norr är kort på vintern', { eyebrow: 'Därför ritar vi som vi gör' }),
      prose('<p>Fönster, takhöjd och färger väljer vi efter hur dagsljuset faller i december, inte i juni.</p>'),
      buttons(button('Om vårt arbetssätt', '/om-oss/')),
    ], { background_image: demoImage('project-3'), background_overlay: 15, text_panel: 'dark_glass', min_height: 'md', text_position: { mobile: 'bottom-center', laptop: 'center-start' } }),
    section([
      heading('Från första skiss till inflyttning', { eyebrow: 'Så arbetar vi', subtitle: 'Ett team följer projektet hela vägen, så att idéerna överlever bygget.' }),
      b('core/feature_grid', { motion: 'rise', items: [
        { icon: 'sun', heading: 'Ljusstudier', text: '<p>Vi simulerar dagsljuset rum för rum innan vi bestämmer var fönstren ska sitta.</p>', link: '/tjanster/' },
        { icon: 'home', heading: 'Bostäder', text: '<p>Villor, fritidshus och flerbostadshus med plats för vardagen.</p>', link: '/projekt/' },
        { icon: 'leaf', heading: 'Hållbart', text: '<p>Trästommar, lokala material och energi som räcker hela året.</p>', link: '/om-oss/' },
      ] }),
    ]),
    b('core/feature_row', {
      eyebrow: 'Utvalt projekt', heading: 'Villa Sjöbris', text: '<p>En familj ville bo nära vattnet utan att offra utsikten för grannarna. Huset trappar ned mot stranden och har ett glasat allrum som fångar kvällssolen.</p>',
      primary_label: 'Läs om projektet', primary_url: '/projekt/', image: demoImage('project-1'), image_alt: 'Villa Sjöbris från sjösidan', image_side: 'left', width: 'wide',
    }),
    b('core/feature_row', {
      eyebrow: 'Inredning', heading: 'Rum som går att leva i', text: '<p>Vi ritar fasta möbler, förvaring och belysning tillsammans med huset, så att allt får plats från början.</p>',
      primary_label: 'Våra tjänster', primary_url: '/tjanster/', image: demoImage('interior-1'), image_alt: 'Vardagsrum med stora fönster', image_side: 'right', width: 'wide',
    }),
    section([
      heading('Det här säger våra kunder', { align: 'center' }),
      b('core/testimonials', { items: [
        { quote: '<p>De lyssnade på hur vi faktiskt lever och ritade ett hus som passar oss, inte en katalog.</p>', name: 'Maria Lindqvist', role: 'Husägare', company: 'Holmsund', avatar: demoImage('person-1') },
        { quote: '<p>Skolan blev ljusare och tystare än vi vågat hoppas. Eleverna märker skillnaden varje dag.</p>', name: 'Johan Berg', role: 'Rektor', company: 'Ekhagenskolan', avatar: demoImage('person-2') },
        { quote: '<p>Tydliga tidplaner, ärliga kalkyler och inga överraskningar på byggplatsen.</p>', name: 'Sara Nyström', role: 'Projektchef', company: 'Nordbygg', avatar: demoImage('person-3') },
      ] }),
    ], { background: '#f3efe8', divider_top: 'wave' }),
    b('core/cta', {
      eyebrow: 'Nästa steg', heading: 'Berätta om ditt projekt', subheading: '<p>Ett första samtal är kostnadsfritt. Vi svarar inom två arbetsdagar.</p>',
      primary_label: 'Boka ett möte', primary_url: '/kontakt/', secondary_label: 'Se priser', secondary_url: '/priser/', width: 'wide',
    }),
  ], { excerpt: 'Arkitektkontor i Umeå som ritar ljusa hus för livet i norr.' });
}

function about() {
  return page('om-oss', '/om-oss/', 'Om oss', [
    section([
      heading('Ett litet kontor med stora fönster', { level: 'h1', eyebrow: 'Om oss', subtitle: 'Fyra arkitekter och en inredare som har ritat hus i Västerbotten sedan 2009.' }),
    ]),
    section([
      columns({ ratio: '2-1' }, [
        prose('<p>Ljusrum grundades av två arkitekter som tröttnat på hus där man tänder lampan klockan två på eftermiddagen. Vi började med fritidshus och ritar i dag allt från villor till skolor.</p><h2>Vad vi tror på</h2><p>Ett bra hus känns självklart när man går in. Det kommer inte av en slump, utan av hundratals små beslut om ljus, akustik och material.</p><h3>Lokalt och långsiktigt</h3><p>Vi arbetar med snickare, konstruktörer och leverantörer i regionen och följer upp våra hus flera år efter inflyttning.</p>'),
        b('core/image', { src: demoImage('project-3'), alt: 'Kontorets entré', caption: 'Vårt kontor i en ombyggd smedja vid älven.', aspect_ratio: '4:3', fit: 'cover' }),
      ]),
    ]),
    section([
      heading('Så går ett uppdrag till'),
      b('core/grid', { cols: 4 }, [
        b('core/step_card', { number: '1', title: 'Samtal', text: '<p>Vi lär känna er, tomten och budgeten.</p>' }),
        b('core/step_card', { number: '2', title: 'Skisser', text: '<p>Tre idéer som skiljer sig på riktigt.</p>' }),
        b('core/step_card', { number: '3', title: 'Bygglov', text: '<p>Ritningar, beskrivningar och kontakt med kommunen.</p>' }),
        b('core/step_card', { number: '4', title: 'Bygget', text: '<p>Vi följer projektet ända till slutbesiktningen.</p>' }),
      ]),
    ]),
    section([
      heading('Vi ritar för ljuset', { align: 'center' }),
      b('core/svg_animation', { svg: '<svg viewBox="0 0 320 200" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 180 H300"/><path d="M60 180 V100 L130 50 L200 100 V180"/><path d="M110 180 V135 H150 V180"/><path d="M75 110 H100 V130 H75 Z"/><path d="M160 110 H185 V130 H160 Z"/><path d="M200 120 H270 V180"/><path d="M215 135 H255 V160 H215 Z"/><circle cx="262" cy="52" r="18"/><path d="M262 22 V14 M262 90 V82 M232 52 H224 M300 52 H292 M241 31 L235 25 M289 79 L283 73 M241 73 L235 79 M289 25 L283 31"/></svg>', label: 'En linjeteckning av ett hus med en sol som lyser in genom fönstren', caption: 'Varje hus börjar som en skiss av hur solen rör sig över tomten.', trigger: 'scroll', effect: 'draw_sequence', position: 45, size: 'large' }),
    ]),
    section([
      heading('Vår historia'),
      b('core/timeline', { layout: 'alternate', items: [
        { date: '2009', title: 'Ett första fritidshus', text: '<p>Elin och Anders ritar ett sommarhus i Bjuröklubb.</p>' },
        { date: '2014', title: 'Kontoret i smedjan', text: '<p>Vi flyttar in i en ombyggd smedja vid älven.</p>', image: demoImage('project-6'), image_alt: 'Smedjan vid älven' },
        { date: '2021', title: 'Ekhagenskolan', text: '<p>Vår första skola, byggd i massivträ.</p>' },
        { date: '2026', title: 'Fem på kontoret', text: '<p>Hanna och Omar är med sedan några år.</p>' },
      ] }),
    ]),
    section([
      heading('Människorna på kontoret'),
      b('core/team_grid', { items: [
        { name: 'Elin Ström', role: 'Arkitekt SAR/MSA', bio: '<p>Grundare. Ritar helst skolor och bibliotek.</p>', photo: demoImage('person-1') },
        { name: 'Anders Öberg', role: 'Arkitekt SAR/MSA', bio: '<p>Grundare. Expert på trästommar.</p>', photo: demoImage('person-2') },
        { name: 'Hanna Vikström', role: 'Inredningsarkitekt', bio: '<p>Ansvarar för interiörer och belysning.</p>', photo: demoImage('person-3') },
        { name: 'Omar Haddad', role: 'Arkitekt', bio: '<p>Leder våra bostadsprojekt.</p>', photo: demoImage('person-4') },
      ] }),
    ]),
    section([
      b('core/testimonial', { quote: '<p>Ljusrum har en ovanlig förmåga att få beställare, grannar och kommun att dra åt samma håll.</p>', name: 'Karin Ek', role: 'Stadsarkitekt', company: 'Umeå kommun', avatar: demoImage('person-5'), style: 'bordered' }),
    ], { width: 'normal' }),
  ], { excerpt: 'Fyra arkitekter och en inredare i Umeå.' });
}

function services() {
  return page('tjanster', '/tjanster/', 'Tjänster', [
    section([
      heading('Tjänster', { level: 'h1', subtitle: 'Vi tar ett projekt från idé till färdigt hus, eller hjälper till med en del av vägen.' }),
      b('core/text', { text: 'Varje uppdrag börjar med ett kostnadsfritt samtal där vi går igenom vad ni behöver och vad det kan kosta.' }),
    ]),
    section([
      b('core/media_card', { image: demoImage('project-5'), image_alt: 'Skiss och modell', heading: 'Nybyggnad', text: '<p>Från första skiss till bygglov och bygghandling. Vi samordnar konstruktör, energiberäkning och kontakt med kommunen.</p>', button_label: 'Boka ett samtal', button_url: '/kontakt/' }),
      b('core/media_card', { image: demoImage('interior-2'), image_alt: 'Ombyggt kök', heading: 'Om- och tillbyggnad', text: '<p>Vi hittar platsen för det nya rummet och ser till att det gamla huset blir bättre, inte bara större.</p>', button_label: 'Se exempel', button_url: '/projekt/', image_side: 'left' }),
    ]),
    section([
      heading('Det ingår alltid'),
      b('core/grid', { cols: 3 }, [
        b('core/icon_box', { icon: 'sun', heading: 'Dagsljusstudie', text: '<p>Simulering av ljuset under årets alla månader.</p>', layout: 'icon-left' }),
        b('core/icon_box', { icon: 'layers', heading: 'Måttsatta ritningar', text: '<p>Underlag som snickaren kan bygga direkt från.</p>', layout: 'icon-left' }),
        b('core/icon_box', { icon: 'phone', heading: 'En kontaktperson', text: '<p>Samma arkitekt från start till slutbesiktning.</p>', layout: 'icon-left' }),
      ]),
    ]),
    section([
      heading('Vanliga frågor'),
      b('core/accordion', { items: [
        { title: 'Hur lång tid tar ett bygglov?', content: '<p>Kommunen har tio veckor på sig från komplett ansökan. Vi brukar räkna med tre till fyra månader från första skiss.</p>' },
        { title: 'Kan ni hjälpa till med ett befintligt hus?', content: '<p>Ja, ungefär hälften av våra uppdrag är om- och tillbyggnader.</p>' },
        { title: 'Arbetar ni utanför Västerbotten?', content: '<p>Vi tar uppdrag i hela norra Sverige och reser gärna till tomten.</p>' },
      ] }),
      buttons(button('Kontakta oss', '/kontakt/'), button('Se priser', '/priser/', 'secondary')),
    ], { width: 'normal' }),
    section([
      heading('Så går ett nybygge till'),
      b('core/scroll_steps', { items: [
        { title: 'Vi går runt på tomten', text: '<p>Vi tittar på sol, vind, utsikt och grannar, och skriver ner hur ni vill bo.</p>', image: demoImage('project-1'), image_alt: 'Tomten vid sjön' },
        { title: 'Tre skisser', text: '<p>Tre idéer som skiljer sig på riktigt, med en grov kostnad för varje.</p>', image: demoImage('project-5'), image_alt: 'Skisser och modell' },
        { title: 'Bygglov och handlingar', text: '<p>Vi tar fram ritningar och sköter kontakten med kommunen.</p>' },
        { title: 'Bygget', text: '<p>Vi följer bygget varje vecka tills ni får nycklarna.</p>', image: demoImage('project-3'), image_alt: 'Det färdiga huset' },
      ] }),
    ]),
  ]);
}

function pricing() {
  const row = (cells: string[], header = false) => ({ cells: cells.map(html => ({ html, header })) });
  return page('priser', '/priser/', 'Priser', [
    section([
      heading('Priser', { level: 'h1', subtitle: 'Fasta paket för de vanligaste uppdragen. Större projekt offererar vi efter ett första möte.', align: 'center' }),
      b('core/pricing_table', { items: [
        { name: 'Skiss', price: '18 000 kr', period: 'fast pris', description: 'För dig som vill se vad som är möjligt.', features: [{ text: 'Platsbesök' }, { text: 'Tre skissförslag' }, { text: 'Grov kostnadsbedömning' }, { text: 'Bygglovsritningar', included: false }], cta_label: 'Välj Skiss', cta_href: '/kontakt/' },
        { name: 'Bygglov', price: '64 000 kr', period: 'fast pris', description: 'Från idé till beviljat bygglov.', features: [{ text: 'Allt i Skiss' }, { text: 'Dagsljusstudie' }, { text: 'Bygglovsritningar' }, { text: 'Kontakt med kommunen' }], cta_label: 'Välj Bygglov', cta_href: '/kontakt/', highlight: true, badge: 'Vanligast' },
        { name: 'Hela vägen', price: 'Offert', period: '', description: 'Vi följer projektet till inflyttning.', features: [{ text: 'Allt i Bygglov' }, { text: 'Bygghandlingar' }, { text: 'Byggledning och besiktning' }], cta_label: 'Begär offert', cta_href: '/kontakt/' },
      ] }),
    ]),
    section([
      heading('Jämför paketen'),
      b('core/table', { caption: '<p>Alla priser inklusive moms.</p>', rows: [
        row(['', 'Skiss', 'Bygglov', 'Hela vägen'], true), row(['Platsbesök', 'Ja', 'Ja', 'Ja']), row(['Dagsljusstudie', 'Nej', 'Ja', 'Ja']),
        row(['Bygglovsritningar', 'Nej', 'Ja', 'Ja']), row(['Byggledning', 'Nej', 'Nej', 'Ja']),
      ], striped: true }),
      b('core/list', { marker: 'check', items: [{ html: 'Fast pris, ingen löpande räkning' }, { html: 'ROT-avdrag gäller inte arkitekttjänster' }, { html: 'Avbokningsbart fram till skissmötet' }] }),
    ], { width: 'normal' }),
  ]);
}

function projects() {
  const card = (n: number, title: string, excerpt: string) => b('core/post_card', { title, excerpt, image: demoImage(`project-${n}` as never), image_alt: title, href: '/projekt/', show_date: false, appearance: 'card', image_aspect: 'landscape', image_fit: 'cover' });
  return page('projekt', '/projekt/', 'Projekt', [
    section([
      heading('Projekt', { level: 'h1', subtitle: 'Ett urval av det vi har ritat de senaste åren.' }),
      b('core/gallery', { items: [1, 2, 3, 4, 5, 6].map(n => ({ src: demoImage(`project-${n}` as never), alt: `Projekt ${n}`, caption: ['Villa Sjöbris', 'Kök i Teg', 'Ekhagenskolan', 'Loft på Öst', 'Fritidshus i Bjuröklubb', 'Kontor vid älven'][n - 1] })) }),
    ]),
    section([
      b('core/tabs', { headline: 'Utvalda uppdrag', labels: [{ label: 'Bostäder' }, { label: 'Offentligt' }, { label: 'Kontor' }] }),
    ]),
    section([
      heading('Före och efter: Loft på Öst'),
      b('core/before_after', { before_image: demoImage('interior-2'), before_alt: 'Vinden före ombyggnaden', after_image: demoImage('interior-3'), after_alt: 'Lägenheten efter ombyggnaden', aspect_ratio: '16:9' }),
    ]),
    b('core/scroll_film', { frames: [1, 2, 3, 4, 5, 6].map(n => ({ src: demoImage(`project-${n}` as never) })), description: 'Sex av våra projekt', length: 'short', captions: [
      { text: '<p><strong>Sex hus</strong>, ett sätt att arbeta.</p>', start: 0, end: 45 },
      { text: '<p>Vart och ett ritat för sin tomt och sitt ljus.</p>', start: 50, end: 100, align: 'end' },
    ] }),
    b('core/divider', { width: 'normal' }),
    section([
      heading('Fler projekt'),
      b('core/grid', { cols: 3 }, [
        card(4, 'Loft på Öst', 'En vind blev en ljus lägenhet med takfönster i söder.'),
        card(5, 'Fritidshus i Bjuröklubb', 'Ett litet hus som tål vind, salt och vinterstormar.'),
        card(6, 'Kontor vid älven', 'Tjugo arbetsplatser i en gammal smedja.'),
      ]),
      b('core/spacer', { height: 'sm' }),
      buttons(button('Berätta om ditt projekt', '/kontakt/')),
    ]),
  ]);
}

function withTabPanels(projectsPage: ReturnType<typeof projects>) {
  const tabs = projectsPage.blocks[1]!.children![0]!;
  tabs.slots = [
    [b('core/feature_row', { heading: 'Villa Sjöbris', text: '<p>Fyra sovrum, ett glasat allrum och en brygga.</p>', image: demoImage('project-1'), image_alt: 'Villa Sjöbris' })],
    [b('core/feature_row', { heading: 'Ekhagenskolan', text: '<p>En F–6-skola för 300 elever, byggd i massivträ.</p>', image: demoImage('project-3'), image_alt: 'Ekhagenskolan' })],
    [b('core/feature_row', { heading: 'Kontor vid älven', text: '<p>Tjugo arbetsplatser och ett kafé som är öppet för grannarna.</p>', image: demoImage('project-6'), image_alt: 'Kontoret' })],
  ];
  return projectsPage;
}

function journal() {
  return page('journal', '/journal/', 'Journal', [
    section([
      heading('Journal', { level: 'h1', subtitle: 'Tankar om ljus, material och hur man bor bra i norr.' }),
      b('core/page_list', { cols: 3 }),
    ]),
    section([
      b('core/audio', { src: '/demo-media/podd-4.mp3', title: 'Podd: Därför ritar vi i trä', description: '<p>Tjugo minuter med Anders Öberg om massivträ, akustik och klimat.</p>', cover: demoImage('project-5'), transcript_url: '/journal/ljus-i-sma-rum/' }),
    ], { width: 'normal' }),
    section([
      heading('Mest lästa'),
      b('core/grid', { cols: 2 }, [
        b('core/post_card', { title: 'Ljus i små rum', excerpt: 'Fem sätt att få dagsljuset längre in i huset.', image: demoImage('interior-3'), image_alt: 'Litet rum med fönster', href: '/journal/ljus-i-sma-rum/', date: '2026-10-12', layout: 'row', image_fit: 'cover' }),
        b('core/post_card', { title: 'Varför vi ritar i trä', excerpt: 'Om klimat, akustik och doften av nysågat.', image: demoImage('project-5'), image_alt: 'Trähus', href: '/journal/ljus-i-sma-rum/', date: '2026-09-02', layout: 'row', image_fit: 'cover' }),
      ]),
    ]),
  ]);
}

function article() {
  return page('ljus-i-sma-rum', '/journal/ljus-i-sma-rum/', 'Ljus i små rum', [
    prose('<p>Ett litet rum känns större när ljuset når hela vägen in. Det handlar sällan om fler fönster, utan om var de sitter och vad ljuset möter.</p><h2>Placera fönstren högt</h2><p>Ljus som kommer in högt når längre in i rummet. Ett överljus ovanför en dörr eller ett band av fönster under taket gör mer än ett stort fönster i ögonhöjd.</p><h3>Tänk på årstiderna</h3><p>Vintersolen står lågt och når långt in, sommarsolen högt och behöver skuggas. Ett djupt takutsprång ger båda.</p>'),
    b('core/image', { src: demoImage('interior-3'), alt: 'Rum med högt sittande fönster', caption: 'Ett band av fönster under taket lyser upp hela rummet.', aspect_ratio: '16:9', fit: 'cover', width: 'wide' }),
    b('core/rich_heading', { html: 'Ljusa ytor <em>reflekterar</em> mer', level: 'h2' }),
    prose('<p>En vit vägg reflekterar ungefär åtta gånger mer ljus än en mörk. Börja med taket och väggen mittemot fönstret.</p>'),
    b('core/list', { items: [{ html: 'Måla taket i en ljusare nyans än väggarna' }, { html: 'Välj matta ytor för att undvika bländning' }, { html: 'Låt golvet vara mellanmörkt, så att rummet inte flyter' }] }),
    heading('Se hur vi gjorde i Teg'),
    b('core/video', { source: 'url', video_url: '/demo-media/missing.mp4', poster: demoImage('project-2'), click_to_load: true, title: 'Rundvandring i köket i Teg' }),
    b('core/embed', { html: '<aside style="padding:1rem;border-left:4px solid currentColor">Inbäddat innehåll visas här, till exempel en karta eller en ritning.</aside>' }),
    b('core/field_list', { title: 'Om artikeln', fields: [{ field: 'author', label: 'Skribent' }, { field: 'date_published', label: 'Publicerad' }] }),
  ], { parent: 'journal', template: 'starter-article', excerpt: 'Fem sätt att få dagsljuset längre in i huset.', og_image: demoImage('interior-3'), author: 'Hanna Vikström', date_published: '2026-10-12' });
}

function contact() {
  return page('kontakt', '/kontakt/', 'Kontakt', [
    section([
      heading('Kontakt', { level: 'h1', subtitle: 'Ring, mejla eller kom förbi. Kaffet står alltid på.' }),
      columns({ ratio: '1-1' }, [
        b('core/container', { gap: 'sm' }, [
          b('core/icon', { icon: 'phone', size: 'lg' }),
          b('core/text', { text: '090-12 34 56, vardagar 8–17' }),
          b('core/icon', { icon: 'mail', size: 'lg' }),
          b('core/text', { text: 'hej@ljusrum.example' }),
          b('core/html', { html: '<address>Ljusrum Arkitekter<br>Smedjegatan 4<br>903 26 Umeå</address>' }),
        ]),
        b('core/container', { gap: 'sm' }, [
          heading('Hitta rätt', { level: 'h3' }),
          b('core/navigation_links', { group_label: 'Genvägar', links: LINKS.slice(0, 4) }),
          b('core/navigation', { links: LINKS, menu_label: 'Meny' }),
          b('core/search', { placeholder: 'Sök på sajten' }),
        ]),
      ]),
    ]),
    section([
      heading('Var bor du?', { subtitle: 'Vi berättar vilken arkitekt som har närmast till dig.' }),
      b('core/navigation_form', { destination: '/kontakt/', button_label: 'Visa', fields: [{ name: 'postnummer', label: 'Postnummer', kind: 'text', placeholder: '903 26', required: true }] }),
      b('core/global_block', { global_block_id: 'kontaktremsa' }),
    ], { width: 'normal' }),
  ]);
}

/** The template starter's interface words are English; a Swedish site sets its own. */
function swedishLabels(blocks: Block[]): Block[] {
  return blocks.map(block => ({ ...block,
    data: { ...block.data, ...(block.type === 'template/page_breadcrumbs' ? { home_label: 'Hem' } : {}), ...(block.type === 'core/table_of_contents' ? { title: 'På den här sidan' } : {}) },
    ...(block.children ? { children: swedishLabels(block.children) } : {}) }));
}

export function demoSite(renderVersion = LATEST_RENDER_VERSION) {
  counter = 0;
  const pages = [home(), about(), services(), pricing(), withTabPanels(projects()), journal(), article(), contact()];
  const settings = { ...structuredClone(defaultSiteSettings), styles: newSiteStyles(), site_name: 'Ljusrum Arkitekter', language: 'sv', tagline: 'Hus som tar vara på ljuset', trailing_slash: 'always', render_version: renderVersion };
  return {
    pages: pages.map(p => p.path),
    publication: {
      format: 'typeroll-static-publication', format_version: 2, publication_id: 'd'.repeat(64), core_commit: 'd'.repeat(40),
      site_url: 'https://ljusrum.example.invalid', version_id: 'main', site: { name: 'Ljusrum Arkitekter' }, settings,
      pages, media: [], contentTypes: [], blockTypes: [], forms: [], redirects: [],
      pageTemplates: [{ id: 'starter-article', name: 'Artikel', status: 'published', blocks: swedishLabels(getPageTemplateStarter('article')!) }],
      partials: [
        ...(['header', 'footer'] as const).map(kind => ({ id: kind, kind, status: 'published', content_mode: 'blocks', blocks: [
          ...(kind === 'header' ? [b('core/announcement_bar', { text: '<p>Vi har öppet hus i smedjan lördag 14 november.</p>', link_label: 'Anmäl dig', link_url: '/kontakt/' })] : []),
          ...getPartialCompositionStarter(kind, { links: LINKS }),
        ] })),
        { id: 'kontaktremsa', kind: 'free', name: 'Kontaktremsa', status: 'published', content_mode: 'blocks', blocks: [
          b('core/cta', { heading: 'Hellre ett samtal?', subheading: '<p>Ring oss på 090-12 34 56.</p>', primary_label: 'Ring nu', primary_url: '/kontakt/', align: 'left' }),
        ] },
      ],
    },
  };
}
