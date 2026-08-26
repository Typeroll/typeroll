// The integrations catalog — third-party tags a site owner turns on with an
// ID instead of pasting a vendor's <script> into settings.scripts_head.
//
// This is a security improvement over the status quo, not a relaxation. The
// customer supplies an identifier; the snippet around it is reviewed platform
// code, versioned with the release and fixable centrally when a vendor changes
// their embed. Today the same customer pastes whatever the vendor's docs told
// them to, into a settings textarea nobody reviews.
//
// Lives in `shared` because both sides need it: the portal derives the app's
// config-field schema from this catalog, and the site-template renderer emits
// the snippets at build time.
//
// SCOPE: site-wide tags only (head / body end). "Placed" embeds — a Mailchimp
// signup form, a Facebook page feed — are a `core/embed` block with the
// vendor's markup, which needs no catalog entry. A curated block library for
// them is a separate step that needs AppDef.blocks (see the app-runtime
// contract in docs/directory-app-plan.md §1).

/**
 * Standard CMP taxonomy. `necessary` tags fire regardless of consent;
 * everything else is held when the site runs in consent-required mode.
 */
export type ConsentCategory = 'necessary' | 'functional' | 'analytics' | 'marketing';

export interface IntegrationField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  /**
   * Anchored at use. Values that don't match are DROPPED rather than
   * embedded — the value lands inside a `<script>` element, so a stray quote
   * would break the page and a crafted one would be an injection. Only an
   * admin can write these, so this guards against a typo becoming a broken
   * site rather than against a hostile author; it's cheap either way.
   */
  pattern: RegExp;
}

export interface IntegrationProvider {
  id: string;
  name: string;
  /** Grouping in the portal UI. */
  group: 'analytics' | 'advertising' | 'support' | 'marketing';
  consent_category: ConsentCategory;
  placement: 'head' | 'body_end';
  fields: IntegrationField[];
  /** Docs URL shown next to the field so the owner can find their ID. */
  docs?: string;
  /**
   * Builds the tag. Receives validated field values keyed by `field.key`.
   * Returning '' means "nothing to emit".
   */
  snippet: (v: Record<string, string>) => string;
}

// Common ID shapes. Deliberately narrow — every one of these vendors issues
// identifiers from a restricted alphabet.
const ALNUM = /^[A-Za-z0-9_-]{1,64}$/;
const NUMERIC = /^[0-9]{1,32}$/;
const GA4 = /^G-[A-Z0-9]{4,20}$/;
const GTM = /^GTM-[A-Z0-9]{4,20}$/;
const DOMAIN = /^[a-z0-9.-]{3,253}$/;
const HTTPS_URL = /^https:\/\/[a-z0-9.-]{3,253}(\/[A-Za-z0-9/_-]*)?$/;

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  // ─── Analytics ─────────────────────────────────────────────────────────
  {
    id: 'google_analytics',
    name: 'Google Analytics 4',
    group: 'analytics',
    consent_category: 'analytics',
    placement: 'head',
    docs: 'https://support.google.com/analytics/answer/9539598',
    fields: [{ key: 'measurement_id', label: 'Measurement ID', placeholder: 'G-XXXXXXXXXX', pattern: GA4 }],
    snippet: (v) =>
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${v.measurement_id}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
      `gtag('js',new Date());gtag('config','${v.measurement_id}');</script>`,
  },
  {
    id: 'google_tag_manager',
    name: 'Google Tag Manager',
    group: 'analytics',
    // GTM is a container that can load anything, including ad tags — so it
    // takes the strictest category rather than the one it looks like.
    consent_category: 'marketing',
    placement: 'head',
    docs: 'https://support.google.com/tagmanager/answer/6103696',
    fields: [{ key: 'container_id', label: 'Container ID', placeholder: 'GTM-XXXXXXX', pattern: GTM }],
    snippet: (v) =>
      `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});` +
      `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;` +
      `j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);` +
      `})(window,document,'script','dataLayer','${v.container_id}');</script>`,
  },
  {
    id: 'hotjar',
    name: 'Hotjar',
    group: 'analytics',
    consent_category: 'analytics',
    placement: 'head',
    fields: [{ key: 'site_id', label: 'Site ID', placeholder: '1234567', pattern: NUMERIC }],
    snippet: (v) =>
      `<script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};` +
      `h._hjSettings={hjid:${v.site_id},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');` +
      `r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);` +
      `})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');</script>`,
  },
  {
    id: 'microsoft_clarity',
    name: 'Microsoft Clarity',
    group: 'analytics',
    consent_category: 'analytics',
    placement: 'head',
    fields: [{ key: 'project_id', label: 'Project ID', placeholder: 'abcdefghij', pattern: ALNUM }],
    snippet: (v) =>
      `<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};` +
      `t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;` +
      `y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);` +
      `})(window,document,"clarity","script","${v.project_id}");</script>`,
  },
  {
    id: 'plausible',
    name: 'Plausible',
    group: 'analytics',
    // Cookieless and aggregate-only, but still analytics — the category is
    // about what the visitor is consenting to, not about cookie mechanics.
    consent_category: 'analytics',
    placement: 'head',
    fields: [{ key: 'domain', label: 'Domain', placeholder: 'example.com', pattern: DOMAIN }],
    snippet: (v) => `<script defer data-domain="${v.domain}" src="https://plausible.io/js/script.js"></script>`,
  },
  {
    id: 'fathom',
    name: 'Fathom Analytics',
    group: 'analytics',
    consent_category: 'analytics',
    placement: 'head',
    fields: [{ key: 'site_id', label: 'Site ID', placeholder: 'ABCDEFGH', pattern: ALNUM }],
    snippet: (v) => `<script src="https://cdn.usefathom.com/script.js" data-site="${v.site_id}" defer></script>`,
  },
  {
    id: 'matomo',
    name: 'Matomo',
    group: 'analytics',
    consent_category: 'analytics',
    placement: 'head',
    fields: [
      { key: 'url', label: 'Matomo URL', placeholder: 'https://analytics.example.com', pattern: HTTPS_URL },
      { key: 'site_id', label: 'Site ID', placeholder: '1', pattern: NUMERIC },
    ],
    snippet: (v) =>
      `<script>var _paq=window._paq=window._paq||[];_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);` +
      `(function(){var u="${v.url.replace(/\/$/, '')}/";_paq.push(['setTrackerUrl',u+'matomo.php']);` +
      `_paq.push(['setSiteId','${v.site_id}']);var d=document,g=d.createElement('script'),` +
      `s=d.getElementsByTagName('script')[0];g.async=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();</script>`,
  },

  // ─── Advertising pixels ────────────────────────────────────────────────
  {
    id: 'meta_pixel',
    name: 'Meta Pixel (Facebook)',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'pixel_id', label: 'Pixel ID', placeholder: '123456789012345', pattern: NUMERIC }],
    snippet: (v) =>
      `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?` +
      `n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;` +
      `n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];` +
      `s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
      `fbq('init','${v.pixel_id}');fbq('track','PageView');</script>`,
  },
  {
    id: 'linkedin_insight',
    name: 'LinkedIn Insight Tag',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'body_end',
    fields: [{ key: 'partner_id', label: 'Partner ID', placeholder: '1234567', pattern: NUMERIC }],
    snippet: (v) =>
      `<script>_linkedin_partner_id="${v.partner_id}";window._linkedin_data_partner_ids=` +
      `window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);` +
      `(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}` +
      `var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";` +
      `b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);` +
      `})(window.lintrk);</script>`,
  },
  {
    id: 'tiktok_pixel',
    name: 'TikTok Pixel',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'pixel_id', label: 'Pixel ID', placeholder: 'CXXXXXXXXXXXXXXXXXXX', pattern: ALNUM }],
    snippet: (v) =>
      `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];` +
      `ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];` +
      `ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};` +
      `for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);` +
      `ttq.load=function(e){var n="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};` +
      `ttq._i[e]=[];ttq._i[e]._u=n;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]={};` +
      `var o=d.createElement("script");o.type="text/javascript";o.async=!0;o.src=n+"?sdkid="+e+"&lib="+t;` +
      `var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};` +
      `ttq.load('${v.pixel_id}');ttq.page();}(window,document,'ttq');</script>`,
  },
  {
    id: 'pinterest_tag',
    name: 'Pinterest Tag',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'tag_id', label: 'Tag ID', placeholder: '2612345678901', pattern: NUMERIC }],
    snippet: (v) =>
      `<script>!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(` +
      `Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";` +
      `var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];` +
      `r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");` +
      `pintrk('load','${v.tag_id}');pintrk('page');</script>`,
  },
  {
    id: 'snap_pixel',
    name: 'Snap Pixel',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'pixel_id', label: 'Pixel ID', placeholder: '00000000-0000-0000-0000-000000000000', pattern: /^[A-Za-z0-9-]{8,64}$/ }],
    snippet: (v) =>
      `<script>(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?` +
      `a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s='script';` +
      `var r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];` +
      `u.parentNode.insertBefore(r,u)})(window,document,'https://sc-static.net/scevent.min.js');` +
      `snaptr('init','${v.pixel_id}');snaptr('track','PAGE_VIEW');</script>`,
  },
  {
    id: 'reddit_pixel',
    name: 'Reddit Pixel',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'advertiser_id', label: 'Advertiser ID', placeholder: 't2_xxxxxxx', pattern: ALNUM }],
    snippet: (v) =>
      `<script>!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):` +
      `p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js";` +
      `t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);` +
      `rdt('init','${v.advertiser_id}');rdt('track','PageVisit');</script>`,
  },
  {
    id: 'x_pixel',
    name: 'X (Twitter) Pixel',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'pixel_id', label: 'Pixel ID', placeholder: 'oXXXXX', pattern: ALNUM }],
    snippet: (v) =>
      `<script>!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments)},` +
      `s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',` +
      `a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');` +
      `twq('config','${v.pixel_id}');</script>`,
  },
  {
    id: 'bing_uet',
    name: 'Microsoft Advertising (UET)',
    group: 'advertising',
    consent_category: 'marketing',
    placement: 'head',
    fields: [{ key: 'tag_id', label: 'UET Tag ID', placeholder: '12345678', pattern: NUMERIC }],
    snippet: (v) =>
      `<script>(function(w,d,t,r,u){var f,n,i;w[u]=w[u]||[],f=function(){var o={ti:"${v.tag_id}"};` +
      `o.q=w[u],w[u]=new UET(o),w[u].push("pageLoad")},n=d.createElement(t),n.src=r,n.async=1,` +
      `n.onload=n.onreadystatechange=function(){var s=this.readyState;s&&s!=="loaded"&&s!=="complete"||(f(),` +
      `n.onload=n.onreadystatechange=null)},i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)` +
      `})(window,document,"script","//bat.bing.com/bat.js","uetq");</script>`,
  },

  // ─── Marketing platforms ───────────────────────────────────────────────
  {
    id: 'hubspot',
    name: 'HubSpot',
    group: 'marketing',
    consent_category: 'marketing',
    placement: 'body_end',
    fields: [{ key: 'portal_id', label: 'Hub ID', placeholder: '1234567', pattern: NUMERIC }],
    snippet: (v) =>
      `<script id="hs-script-loader" async defer src="https://js.hs-scripts.com/${v.portal_id}.js"></script>`,
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp (Connected Site)',
    group: 'marketing',
    consent_category: 'marketing',
    placement: 'body_end',
    fields: [{ key: 'user_id', label: 'Connected Site ID', placeholder: 'abc123def456', pattern: ALNUM }],
    snippet: (v) =>
      `<script id="mcjs">!function(c,h,i,m,p){m=c.createElement(h),p=c.getElementsByTagName(h)[0],` +
      `m.async=1,m.src=i,p.parentNode.insertBefore(m,p)}(document,"script",` +
      `"https://chimpstatic.com/mcjs-connected/js/users/${v.user_id}.js");</script>`,
  },

  // ─── Support widgets ───────────────────────────────────────────────────
  {
    id: 'intercom',
    name: 'Intercom',
    group: 'support',
    consent_category: 'functional',
    placement: 'body_end',
    fields: [{ key: 'app_id', label: 'App ID', placeholder: 'abcd1234', pattern: ALNUM }],
    snippet: (v) =>
      `<script>window.intercomSettings={app_id:"${v.app_id}"};` +
      `(function(){var w=window,ic=w.Intercom;if(typeof ic==="function"){ic('reattach_activator');ic('update',w.intercomSettings)}` +
      `else{var d=document,i=function(){i.c(arguments)};i.q=[];i.c=function(args){i.q.push(args)};w.Intercom=i;` +
      `var s=d.createElement('script');s.async=true;s.src='https://widget.intercom.io/widget/${v.app_id}';` +
      `var x=d.getElementsByTagName('script')[0];x.parentNode.insertBefore(s,x)}})();</script>`,
  },
  {
    id: 'crisp',
    name: 'Crisp Chat',
    group: 'support',
    consent_category: 'functional',
    placement: 'body_end',
    fields: [{ key: 'website_id', label: 'Website ID', placeholder: '00000000-0000-0000-0000-000000000000', pattern: /^[A-Za-z0-9-]{8,64}$/ }],
    snippet: (v) =>
      `<script>window.$crisp=[];window.CRISP_WEBSITE_ID="${v.website_id}";` +
      `(function(){var d=document,s=d.createElement("script");s.src="https://client.crisp.chat/l.js";s.async=1;` +
      `d.getElementsByTagName("head")[0].appendChild(s)})();</script>`,
  },
  {
    id: 'tawk_to',
    name: 'Tawk.to',
    group: 'support',
    consent_category: 'functional',
    placement: 'body_end',
    fields: [
      { key: 'property_id', label: 'Property ID', placeholder: '5f000000000000000000000', pattern: ALNUM },
      { key: 'widget_id', label: 'Widget ID', placeholder: 'default', pattern: ALNUM },
    ],
    snippet: (v) =>
      `<script>var Tawk_API=Tawk_API||{},Tawk_LoadStart=new Date();` +
      `(function(){var s1=document.createElement("script"),s0=document.getElementsByTagName("script")[0];` +
      `s1.async=true;s1.src='https://embed.tawk.to/${v.property_id}/${v.widget_id}';s1.charset='UTF-8';` +
      `s1.setAttribute('crossorigin','*');s0.parentNode.insertBefore(s1,s0)})();</script>`,
  },
] as const;

export function getIntegrationProvider(id: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id);
}

/** Flat config key for a provider field: `meta_pixel__pixel_id`. */
export function integrationConfigKey(providerId: string, fieldKey: string): string {
  return `${providerId}__${fieldKey}`;
}

export interface IntegrationTags {
  /** Tags that fire on every load — the `necessary` category. */
  head: string;
  bodyEnd: string;
  /**
   * Tags whose category requires consent. Kept separate so the CALLER can
   * route them through the platform's existing consent gate
   * (`wrapConsentScripts` + the CookieConsent runtime) rather than this
   * module inventing a second one. When a site has no cookie banner enabled,
   * the caller emits them directly — the site owner declared no consent
   * requirement, and that's their call to make, not ours.
   */
  headConsent: string;
  bodyEndConsent: string;
  /** Provider ids actually emitted — for tests and the portal's status UI. */
  emitted: string[];
}

/**
 * Turn stored app config into the tags for one page.
 *
 * A provider is on when every one of its fields has a value that matches its
 * pattern. A value that fails validation drops the whole provider rather than
 * emitting a half-built snippet: these are `<script>` bodies, and a broken one
 * is worse than a missing one.
 */
export function renderIntegrationTags(
  config: Record<string, unknown> | undefined,
): IntegrationTags {
  const head: string[] = [];
  const bodyEnd: string[] = [];
  const headConsent: string[] = [];
  const bodyEndConsent: string[] = [];
  const emitted: string[] = [];
  const empty = { head: '', bodyEnd: '', headConsent: '', bodyEndConsent: '', emitted };
  if (!config) return empty;

  for (const provider of INTEGRATION_PROVIDERS) {
    const values: Record<string, string> = {};
    let complete = true;
    for (const field of provider.fields) {
      const raw = config[integrationConfigKey(provider.id, field.key)];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || !field.pattern.test(value)) { complete = false; break; }
      values[field.key] = value;
    }
    if (!complete) continue;

    const tag = provider.snippet(values);
    if (!tag) continue;
    const needsConsent = provider.consent_category !== 'necessary';
    const bucket = provider.placement === 'head'
      ? (needsConsent ? headConsent : head)
      : (needsConsent ? bodyEndConsent : bodyEnd);
    bucket.push(tag);
    emitted.push(provider.id);
  }

  return {
    head: head.join('\n'),
    bodyEnd: bodyEnd.join('\n'),
    headConsent: headConsent.join('\n'),
    bodyEndConsent: bodyEndConsent.join('\n'),
    emitted,
  };
}
