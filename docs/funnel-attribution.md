# Funnel attribution

Typeroll's optional **Funnel attribution** app forwards allowlisted campaign
parameters from a page URL to exact outbound HTTPS links. It can also emit a
`gtag` event without delaying navigation. Persistent first- and last-touch
cookies are a separate opt-in and are written only after optional consent.

Configure the app under **Site settings → Apps** or through the MCP tools
`read_funnel_attribution` and `update_funnel_attribution`. Changes affect the
static customer build and require a redeploy.

```json
{
  "id": "ai-planen",
  "page_paths": ["/ai-planen/"],
  "source": "current_url",
  "parameters": [
    { "from": "utm_source", "fallback": "autopilot.se" },
    { "from": "utm_medium", "fallback": "website" },
    { "from": "utm_campaign", "fallback": "ai-planen" },
    { "from": "utm_content" },
    { "from": "utm_term" }
  ],
  "targets": [
    {
      "type": "link",
      "host": "calendly.com",
      "path": "/thomaswisten/ai-planen-utforskande-samtal",
      "click_event": "calendly_click",
      "destination": "calendly"
    }
  ]
}
```

Rules preserve unrelated target query parameters and hashes. Parameter names
resembling email, name, phone, or address are rejected unless the admin enables
the explicit personal-data override. Stored snapshots use the versioned
cookies `tr_attr_first_v1` and `tr_attr_last_v1`, contain only allowlisted
values, and never contain a full landing-page URL.

The browser runtime exposes `window.TyperollFunnels.init(root)` for blocks that
mount links dynamically. It deliberately does not install a global
`MutationObserver`.
