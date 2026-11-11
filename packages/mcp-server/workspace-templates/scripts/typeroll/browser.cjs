// Isolated QA browser only. Never persist storage state, cookies or signed URLs.
const fs = require('node:fs/promises');
const path = require('node:path');
// Polite pacing: home connections (ISP, router, DNS) can throttle many rapid
// requests, so the local profile is slow. Cloud runners may go faster.
// Override with TYPEROLL_REQUEST_PROFILE=local|cloud and TYPEROLL_REQUEST_CONCURRENCY=N.
const PROFILES = { local: { concurrency: 2, interval: 300 }, cloud: { concurrency: 5, interval: 100 } };
const CLOUD_MARKERS = ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITHUB_ACTIONS', 'CI'];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3, MAX_DELAY = 60000;
const isSet = value => !['', '0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
function selectProfile(env = process.env) {
  const explicit = String(env.TYPEROLL_REQUEST_PROFILE ?? '').trim().toLowerCase();
  if (explicit && !PROFILES[explicit]) throw Error('TYPEROLL_REQUEST_PROFILE must be local or cloud');
  const marker = CLOUD_MARKERS.find(name => isSet(env[name]));
  const name = explicit || (marker ? 'cloud' : 'local');
  const profile = { ...PROFILES[name], name, reason: explicit ? 'TYPEROLL_REQUEST_PROFILE' : marker || 'default' };
  const raw = String(env.TYPEROLL_REQUEST_CONCURRENCY ?? '').trim();
  if (raw) {
    if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 16) throw Error('TYPEROLL_REQUEST_CONCURRENCY must be a whole number from 1 to 16');
    profile.concurrency = +raw;
  }
  return profile;
}
function describeProfile(p) {
  const hint = p.name === 'local' ? 'on a cloud runner set TYPEROLL_REQUEST_PROFILE=cloud' : 'set TYPEROLL_REQUEST_PROFILE=local on your own computer';
  return `Request profile: ${p.name} (${p.reason}; ${p.concurrency} concurrent, ${p.interval} ms between requests per host). To change it, ${hint}; TYPEROLL_REQUEST_CONCURRENCY=N sets concurrency.`;
}
// Milliseconds requested by a Retry-After header (delta seconds or HTTP date), or null.
function retryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return +text * 1000;
  if (!/[a-z]/i.test(text)) return null;
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}
// Delay before retry attempt+1, or null to stop. status null/undefined means a network error.
function retryDelay(attempt, status, header, now) {
  if (attempt >= MAX_RETRIES || (status != null && !RETRY_STATUSES.has(status))) return null;
  const hinted = retryAfter(header, now);
  const delay = hinted ?? 1000 * 2 ** attempt;
  return delay > MAX_DELAY ? null : delay;
}
let active = null;
const nextStart = new Map();
function requestProfile() {
  if (!active) { active = selectProfile(); console.error(describeProfile(active)); }
  return active;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pace(url) {
  const host = new URL(url).hostname, now = Date.now();
  const start = Math.max(now, nextStart.get(host) ?? now);
  nextStart.set(host, start + requestProfile().interval);
  if (start > now) await sleep(start - now);
}
// Paced navigation; a network error, 429 or 5xx is retried a bounded number of times with backoff.
async function navigate(page, url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    await pace(url);
    let response, delay;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000, ...options });
    } catch (error) {
      delay = error.name === 'TimeoutError' ? null : retryDelay(attempt);
      if (delay == null) throw error;
    }
    if (response !== undefined) {
      const status = response?.status();
      delay = status != null && RETRY_STATUSES.has(status) ? retryDelay(attempt, status, response.headers()['retry-after']) : null;
      if (delay == null) return response;
    }
    await sleep(delay);
  }
}
async function open(page, url) {
  await navigate(page, url);
  // Select only Typeroll's own preview, never an arbitrary ad/video iframe.
  const frame = page.locator('iframe[title="Preview"], iframe[title="Site preview"]');
  if (await frame.count() === 1) {
    await page.waitForFunction(() => document.querySelector('iframe[title="Preview"], iframe[title="Site preview"]')?.getAttribute('src'), null, { timeout: 15000 });
    const src = await frame.getAttribute('src');
    if (!src) throw Error('Preview frame has no source');
    const target = new URL(src, page.url());
    if (target.origin !== new URL(page.url()).origin) throw Error('Unexpected preview frame origin');
    await navigate(page, target.href);
  }
  await page.evaluate(() => document.fonts.ready);
}
async function settle(page) {
  // Bounded for infinite-scroll pages; report coverage rather than hanging.
  for (let y = 0; y < 30000; y += 600) {
    await page.evaluate(y => scrollTo(0, y), y);
    await page.waitForTimeout(100);
    if (y + 900 >= await page.evaluate(() => document.documentElement.scrollHeight)) break;
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
}
async function inspect(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    h1: document.querySelectorAll('h1').length,
    title: document.title,
    robots: document.querySelector('meta[name="robots"]')?.content ?? null,
    fonts: { body: getComputedStyle(document.body).fontFamily, heading: getComputedStyle(document.querySelector('h1') || document.body).fontFamily },
    incompleteImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => new URL(i.currentSrc || i.src, location.href).pathname),
    scrollCoverageComplete: document.documentElement.scrollHeight <= 30000,
  }));
}
async function screenshot(page, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}
function widths(args) {
  const values = (args.length ? args : ['390', '768', '1023', '1024', '1280']).map(Number);
  if (values.some(w => !Number.isInteger(w) || w < 240 || w > 4000)) throw Error('Invalid viewport width');
  return values;
}
function fail() { console.error('QA failed; inspect the target privately. URLs and credentials are withheld.'); process.exitCode = 2; }
module.exports = {
  // Loaded on use, so the pacing helpers also work (and test) without Playwright.
  get chromium() { return require('playwright').chromium; },
  open, navigate, settle, inspect, screenshot, widths, fail,
  selectProfile, describeProfile, requestProfile, retryAfter, retryDelay,
};
