import { beforeEach, describe, expect, it } from "vitest";
import { paths } from "@typeroll/shared";
import type { AnalyticsEvent, SiteApps } from "@typeroll/shared";
import { makeTmpFixtures, resetDatastore } from "../helpers/tmp-fixtures";

const ORG = "default";
const SITE = "mysite";
const SECRET = "analytics-test-secret".padEnd(48, "x");

async function setup(): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  const { getStore } = await import("../../lib/datastore");
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: "My site",
    domain: "www.example.com",
    hosting_adapter: "cloudflare",
    created_at: new Date().toISOString(),
  });
  const apps: SiteApps = {
    apps: {
      analytics: { enabled: true, config: {} },
      funnel_attribution: {
        enabled: true,
        config: {
          funnels: [
            {
              id: "booking",
              page_paths: ["/book/"],
              source: "current_url",
              parameters: [{ from: "utm_source" }, { from: "utm_campaign" }],
              targets: [
                {
                  type: "link",
                  host: "calendly.com",
                  path: "/acme/call",
                  click_event: "booking_click",
                  destination: "calendly",
                },
              ],
            },
          ],
          allow_personal_data: false,
          allow_synthetic_fallbacks: false,
        },
      },
    },
  };
  await getStore().setDoc(paths.apps(ORG, SITE), apps);
  const { signAnalyticsEventToken } =
    await import("../../lib/apps/analytics-events");
  return signAnalyticsEventToken(ORG, SITE);
}

async function post(
  token: string,
  event: Record<string, unknown>,
  origin = "https://www.example.com",
): Promise<Response> {
  const { POST } = await import("../../pages/api/analytics/events");
  return POST({
    request: new Request("https://forms.typeroll.com/api/analytics/events", {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        origin,
        "x-forwarded-for": `10.20.30.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify({ token, event }),
    }),
  } as never) as Promise<Response>;
}

describe("first-party Analytics events", () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it("stores an allowlisted funnel event without visitor identifiers", async () => {
    const token = await setup();
    const response = await post(token, {
      name: "booking_click",
      funnel_id: "booking",
      destination: "calendly",
      path: "/book/",
      attribution: {
        utm_source: "facebook",
        utm_campaign: "launch",
        email: "secret@example.com",
      },
    });
    expect(response.status).toBe(202);

    const { getStore } = await import("../../lib/datastore");
    const rows = await getStore().listDocs<AnalyticsEvent>(
      paths.analyticsEvents(ORG, SITE),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "booking_click",
      funnel_id: "booking",
      destination: "calendly",
      path: "/book/",
      attribution: { utm_source: "facebook", utm_campaign: "launch" },
    });
    expect(rows[0].attribution).not.toHaveProperty("email");
    expect(rows[0]).not.toHaveProperty("ip");
    expect(Date.parse(rows[0].expires_at)).toBeGreaterThan(Date.now());
  });

  it("rejects forged tokens, foreign origins, and undeclared events", async () => {
    const token = await setup();
    const event = {
      name: "booking_click",
      funnel_id: "booking",
      destination: "calendly",
      path: "/book/",
      attribution: {},
    };
    expect((await post(`${token}x`, event)).status).toBe(403);
    expect((await post(token, event, "https://attacker.example")).status).toBe(
      403,
    );
    expect(
      (await post(token, { ...event, name: "arbitrary_event" })).status,
    ).toBe(400);
    const { getStore } = await import("../../lib/datastore");
    expect(
      await getStore().listDocs(paths.analyticsEvents(ORG, SITE)),
    ).toHaveLength(0);
  });

  it("aggregates conversions by event, destination, and source", async () => {
    await setup();
    const { getStore } = await import("../../lib/datastore");
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    for (const [source, campaign] of [
      ["google", "launch"],
      ["google", "launch"],
      ["linkedin", "brand"],
    ]) {
      await getStore().addDoc(paths.analyticsEvents(ORG, SITE), {
        name: "booking_click",
        funnel_id: "booking",
        destination: "calendly",
        path: "/book/",
        attribution: { utm_source: source, utm_campaign: campaign },
        created_at: now,
        expires_at: expires,
      });
    }
    await getStore().addDoc(paths.analyticsEvents(ORG, SITE), {
      name: "booking_click",
      funnel_id: "booking",
      destination: "calendly",
      path: "/book/",
      attribution: { utm_source: "expired" },
      created_at: now,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const { getConversionInsights } =
      await import("../../lib/apps/analytics-events");
    expect(await getConversionInsights(getStore(), ORG, SITE, 30)).toEqual({
      total_events: 3,
      by_event: [{ name: "booking_click", destination: "calendly", count: 3 }],
      by_source: [
        { source: "google", count: 2 },
        { source: "linkedin", count: 1 },
      ],
      by_campaign: [
        { campaign: "launch", count: 2 },
        { campaign: "brand", count: 1 },
      ],
      truncated: false,
    });
    expect(
      await getStore().listDocs(paths.analyticsEvents(ORG, SITE)),
    ).toHaveLength(3);
  });
});
