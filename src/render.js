// v0.13.0: JavaScript render. Opens HTML pages in a real browser (Playwright, Chromium) and reads the DOM after the JS runs.
// Optional: playwright-core is an optional dependency and the browser is installed separately. Without them the crawl stays raw.
//
// Network rule (see CLAUDE.md, v0.13.0): the browser never reaches the network itself.
// 1. Every request of the page (document, script, fetch, iframe, worker) goes to one checkpoint in Node (context.route).
//    The checkpoint applies the host policy, robots.txt, the SSRF guard, the timeout and the body limit of the crawler,
//    follows redirects hop by hop and gives the browser only the last answer. The staging password goes only to the crawled site.
// 2. The browser's own network goes to a dead proxy (also for loopback). A request that skips the checkpoint
//    (a redirect the browser follows itself, preconnect, prefetch) fails there.
// WebSocket and service workers are closed. Each page gets a new browser context (no cookies or storage from another page).
import net from 'node:net';
import { bareHost } from './normalize.js';
import { parsePage } from './parser.js';

const NAV_TYPES = new Set(['document']);
const CACHE_TYPES = new Set(['script', 'stylesheet']);
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const PASS_HEADERS = ['accept', 'content-type', 'accept-language'];
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'alt-svc']);

let pwPromise = null;
async function loadPlaywright() {
  if (!pwPromise) pwPromise = import('playwright-core').then((m) => m.chromium || m.default?.chromium).catch(() => null);
  return pwPromise;
}

// Is render possible here? Result: { available, reason, code }. A positive answer stays cached; a negative one is
// checked again after 30 seconds (the user can install the browser while the server runs).
let status = null;
export async function renderStatus({ publicMode = false } = {}) {
  if (publicMode) return { available: false, code: 'public', reason: 'Yayın modunda JavaScript render kapalı.' };
  if (status && (status.available || Date.now() - status.at < 30000)) return status;
  const chromium = await loadPlaywright();
  if (!chromium) { status = { available: false, code: 'package', reason: 'playwright-core paketi yok. Kurun: npm install', at: Date.now() }; return status; }
  try {
    const b = await chromium.launch(launchOptions(null));
    await b.close();
    status = { available: true, at: Date.now() };
  } catch (e) {
    status = { available: false, code: 'browser', at: Date.now(),
      reason: 'Chromium yok veya açılmıyor. Kurun: npx playwright-core install chromium-headless-shell (veya .env: CHROMIUM_PATH).',
      detail: String(e.message || e).split('\n')[0].slice(0, 200) };
  }
  return status;
}
export function resetRenderStatus() { status = null; }

function launchOptions(proxyPort) {
  const o = { headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync', '--disable-domain-reliability'] };
  if (process.env.CHROMIUM_PATH) o.executablePath = process.env.CHROMIUM_PATH;
  // "<-loopback>" removes the default loopback bypass: localhost requests also go to the dead proxy.
  if (proxyPort) o.proxy = { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' };
  return o;
}

// A TCP server that closes every connection at once. The browser's own network ends here.
function deadProxy() {
  const s = net.createServer((sock) => sock.destroy());
  s.on('error', () => {});
  return new Promise((ok, fail) => { s.once('error', fail); s.listen(0, '127.0.0.1', () => ok(s)); });
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const matchHost = (host, list) => (list || []).some((h) => { h = String(h || '').toLowerCase().replace(/^\*?\./, ''); return h && (host === h || host.endsWith('.' + h)); });

// Allowed third-party hosts from a form field or a project file: "cdn.ornek.com, *.cdn.example" → ["cdn.ornek.com", "cdn.example"].
export function cleanAllowHosts(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = [];
  for (let h of list) {
    h = String(h || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/^\*\./, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !out.includes(h)) out.push(h);
  }
  return out.slice(0, 20);
}

// Host policy. The crawled site (www is the same site) is always allowed. Then blockHosts wins over its subdomains and allowHosts.
export function makeHostPolicy(rootHost, allowHosts = [], blockHosts = []) {
  const root = bareHost(rootHost);
  return (url) => {
    const host = hostOf(url);
    if (!host) return 'bad';
    const b = bareHost(host);
    if (b === root) return null;
    if (matchHost(host, blockHosts)) return 'blocklist';
    if (b.endsWith('.' + root)) return null;
    if (matchHost(host, allowHosts)) return null;
    return 'third-party';
  };
}

// Creates one browser for one crawl. o: { rootHost, request(url, init), readBody(res, ctrl), isBlocked(url), ignoreRobots,
// allowHosts, cfg (rules.json → render), maxRedirects, userAgent, signal }.
export async function createRenderer(o) {
  const chromium = await loadPlaywright();
  if (!chromium) throw new Error('playwright-core paketi yok');
  const proxy = await deadProxy();
  let browser;
  try { browser = await chromium.launch(launchOptions(proxy.address().port)); }
  catch (e) { proxy.close(); throw e; }
  const cfg = o.cfg;
  const policy = makeHostPolicy(o.rootHost, o.allowHosts, cfg.blockHosts);
  const rootBare = bareHost(o.rootHost);
  const blockTypes = new Set(cfg.blockTypes || []);
  const cache = new Map(); let cacheBytes = 0;
  const cacheMax = (cfg.cacheMb || 0) * 1024 * 1024;
  let active = 0; const waiting = [];
  const acquire = () => (active < Math.max(1, cfg.concurrency || 1) ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const n = waiting.shift(); if (n) n(); else active--; };
  const stats = { pages: 0, failed: 0, ms: 0 };

  // Fetches one browser request through the crawler's request(). Redirects are followed here, each hop is checked.
  async function fetchFor(url, method, headers, postData, st) {
    let current = url;
    for (let hop = 0; hop <= o.maxRedirects; hop++) {
      if (hop > 0) {
        const why = policy(current);
        if (why) { st.block(current, why); return null; }
        if (!o.ignoreRobots && bareHost(hostOf(current)) === rootBare && o.isBlocked(current)) { st.robots(current, 'other'); return null; }
      }
      let r;
      try { r = await o.request(current, { method, headers, body: postData }); }
      catch (e) { st.fail(current, e.cause?.code || e.name); return null; }
      const { res } = r;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        res.body?.cancel?.().catch(() => {}); r.done();
        let next; try { next = new URL(loc, current).href; } catch { return null; }
        current = next;
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; postData = undefined; }
        continue;
      }
      let got;
      try { got = await o.readBody(res, r.ctrl); }
      catch { r.done(); st.fail(current, 'timeout'); return null; }
      r.done();
      if (got.truncated) st.truncated++;
      const h = {};
      res.headers.forEach((v, k) => { if (!DROP_HEADERS.has(k)) h[k] = v; });
      return { status: res.status, headers: h, body: got.buf };
    }
    st.fail(url, 'too-many-redirects');
    return null;
  }

  async function render(pageUrl, html) {
    await acquire();
    const t0 = Date.now();
    const blockedHosts = new Map();
    const st = {
      requests: 0, blocked: 0, skipped: 0, failed: 0, truncated: 0, robotsBlocked: [],
      block(u, why) { st.blocked++; const h = hostOf(u) || why; blockedHosts.set(h, (blockedHosts.get(h) || 0) + 1); },
      robots(u, type) { if (st.robotsBlocked.length < 20) st.robotsBlocked.push({ url: u, type }); },
      fail() { st.failed++; },
    };
    let ctx = null; let docServed = false;
    let open = 0; let last = Date.now();
    const out = { ms: 0 };
    try {
      ctx = await browser.newContext({ serviceWorkers: 'block', userAgent: o.userAgent, acceptDownloads: false, javaScriptEnabled: true });
      await ctx.routeWebSocket(/.*/, (ws) => { st.block(ws.url(), 'websocket'); ws.close(); });
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const type = req.resourceType();
        try {
          if (!/^https?:/i.test(url)) return route.abort('blockedbyclient');
          // The page itself: the browser gets the HTML the crawler already read (no second request, same text and charset).
          if (!docServed && NAV_TYPES.has(type) && url === pageUrl) {
            docServed = true;
            return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
          }
          if (++st.requests > cfg.maxRequestsPerPage) { st.skipped++; return route.abort('blockedbyclient'); }
          if (blockTypes.has(type)) { st.skipped++; return route.abort('blockedbyclient'); }
          const why = policy(url);
          if (why) { st.block(url, why); return route.abort('blockedbyclient'); }
          const method = req.method();
          if (!METHODS.has(method)) { st.block(url, 'method'); return route.abort('blockedbyclient'); }
          if (!o.ignoreRobots && bareHost(hostOf(url)) === rootBare && o.isBlocked(url)) { st.robots(url, type); return route.abort('blockedbyclient'); }
          const key = method === 'GET' && CACHE_TYPES.has(type) ? url : null;
          if (key && cache.has(key)) return route.fulfill(cache.get(key));
          const rh = req.headers();
          const headers = {};
          for (const k of PASS_HEADERS) if (rh[k]) headers[k] = rh[k];
          const ans = await fetchFor(url, method, headers, method === 'POST' ? req.postDataBuffer() || undefined : undefined, st);
          if (!ans) return route.abort('failed');
          if (key && ans.status === 200 && cacheBytes + ans.body.length <= cacheMax) { cache.set(key, ans); cacheBytes += ans.body.length; }
          return route.fulfill(ans);
        } catch {
          // The page may close while a request waits. Nothing to do.
          try { await route.abort('failed'); } catch {}
        }
      });
      ctx.on('request', () => { open++; last = Date.now(); });
      const done = () => { open = Math.max(0, open - 1); last = Date.now(); };
      ctx.on('requestfinished', done); ctx.on('requestfailed', done);
      const page = await ctx.newPage();
      page.setDefaultTimeout(cfg.timeoutMs);
      await page.goto(pageUrl, { waitUntil: 'load', timeout: cfg.timeoutMs });
      // Wait until the network is quiet (late fetch content), at most maxWaitMs after load and timeoutMs in total.
      const tl = Date.now();
      for (;;) {
        if (o.signal?.aborted) throw new Error('cancelled');
        const quiet = open === 0 && Date.now() - last >= cfg.quietMs;
        if (quiet) break;
        if (Date.now() - tl >= cfg.maxWaitMs || Date.now() - t0 >= cfg.timeoutMs) { out.waitCapped = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      const left = Math.max(1000, cfg.timeoutMs - (Date.now() - t0));
      out.html = await Promise.race([page.content(), new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), left))]);
      const finalUrl = page.url();
      if (finalUrl && finalUrl !== pageUrl) out.jsUrl = finalUrl;
    } catch (e) {
      out.error = e.name === 'TimeoutError' || /timeout/i.test(e.message || '') ? 'timeout' : String(e.message || e).split('\n')[0].slice(0, 160);
    } finally {
      if (ctx) await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      release();
    }
    out.ms = Date.now() - t0;
    out.requests = Math.min(st.requests, cfg.maxRequestsPerPage);
    out.blocked = st.blocked;
    out.blockedHosts = [...blockedHosts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([host, n]) => ({ host, n }));
    out.skipped = st.skipped;
    out.failed = st.failed;
    if (st.truncated) out.truncated = st.truncated;
    out.robotsBlocked = st.robotsBlocked;
    stats.pages++; stats.ms += out.ms; if (out.error) stats.failed++;
    return out;
  }

  async function close() {
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    proxy.close();
  }
  return { render, close, stats };
}

// Fields that come from the rendered DOM. HTTP fields (status, headers, size, time) and the render-blocking resources of the
// raw HTML stay raw. noindex, tag IDs and full-written hosts are the union of both (raw noindex can stop Google's render).
const RENDER_FIELDS = ['title', 'titleCount', 'metaDescription', 'metaDescriptionCount', 'canonical', 'canonicalCount', 'htmlLang', 'hreflang',
  'h1', 'h2Count', 'headings', 'emptyHeadings', 'ogTitle', 'ogDescription', 'ogImage', 'twitterCard', 'viewport', 'favicon', 'jsonld',
  'imageCount', 'imgNoAlt', 'imgEmptyAlt', 'images', 'unnamedLinks', 'unnamedButtons', 'wordCount', 'contentWordCount', 'contentHash',
  'simhash', 'textSample', 'placeholder', 'mixed'];
const union = (a, b, max = 20) => [...new Set([...(a || []), ...(b || [])])].slice(0, max);

// Short raw summary that stays on the page record (rules and the "Ham HTML ↔ Render" table use it).
export function rawSummary(p) {
  return {
    title: p.title || '', titleCount: p.titleCount || 0, metaDescription: p.metaDescription || '', canonical: p.canonical || '',
    metaRobots: p.metaRobots || '', h1: p.h1 || [], wordCount: p.wordCount || 0, contentWordCount: p.contentWordCount || 0,
    internalLinks: new Set((p.links || []).filter((l) => l.internal).map((l) => l.url)).size,
  };
}

// raw: parsePage result of the raw HTML. html: rendered DOM. Returns the fields to put on the page record.
export function mergeRender(raw, html, pageUrl, rootHost) {
  const r = parsePage(html, pageUrl, rootHost);
  const out = { raw: rawSummary(raw) };
  for (const k of RENDER_FIELDS) out[k] = r[k];
  const rawRobots = raw.metaRobots || ''; const rRobots = r.metaRobots || '';
  out.metaRobots = rawRobots && rRobots && rawRobots !== rRobots ? `${rawRobots}, ${rRobots}` : rawRobots || rRobots;
  out.metaRobotsJs = rRobots;
  out.tracking = union(raw.tracking, r.tracking);
  out.gscVerify = union(raw.gscVerify, r.gscVerify);
  const ah = raw.absHosts || {}; const bh = r.absHosts || {};
  out.absHosts = { canonical: ah.canonical || bh.canonical || '', hreflang: union(ah.hreflang, bh.hreflang), link: union(ah.link, bh.link), asset: union(ah.asset, bh.asset) };
  // Links: rendered links (js: true if the raw HTML does not have them) and raw links that the JS removed (Google reads the raw HTML too).
  const rawUrls = new Set((raw.links || []).map((l) => l.url));
  const seen = new Set();
  out.links = [];
  for (const l of r.links) { out.links.push(rawUrls.has(l.url) ? l : { ...l, js: true }); seen.add(l.url); }
  for (const l of raw.links || []) if (!seen.has(l.url)) out.links.push(l);
  return out;
}
