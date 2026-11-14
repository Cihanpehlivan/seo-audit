// Core crawler: follows internal links, records redirect chains, reads robots.txt and sitemaps.
import robotsParser from 'robots-parser';
import { normalizeUrl, isInternal, looksLikeAsset, bareHost } from './normalize.js';
import { parsePage } from './parser.js';
import { readSitemaps } from './sitemap.js';
import { runChecks } from './checks.js';
import { makeGuard } from './netguard.js';
import { createRenderer, mergeRender } from './render.js';
import { loadConfig } from './rules/index.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const DEFAULTS = {
  maxUrls: 5000,
  maxDepth: 50,
  concurrency: 5,
  delayMs: 0,
  timeoutMs: 15000,
  maxRedirects: 10,
  maxBodyBytes: 5 * 1024 * 1024,
  userAgent: `SEO-Audit/${VERSION}`,
  ignoreRobots: false,
  useSitemap: true,
  auth: null,            // "user:pass" for staging basic auth
  onProgress: null,
  signal: null,          // AbortSignal to stop the crawl
  checks: false,         // true or { site, external, images, variants }: extra checks after the crawl
  onChecks: null,        // progress of the extra checks: { done, total }
  blockPrivate: false,   // public server: never request private or internal addresses (SSRF guard)
  guard: null,           // v0.13.0: custom check(url) → reason or null (tests). Default: makeGuard() when blockPrivate
  seeds: null,           // v0.12.0: only these URLs (old address list). No links, no sitemap, no hop to another host
  render: false,         // v0.13.0: true or { allowHosts: [], limits: {} }: open HTML pages in Chromium (src/render.js). Not in list mode
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeBody(buf, contentType) {
  let charset = /charset=([^;]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder((charset || 'utf-8').trim().toLowerCase()).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

function sitemapHosts(urls) {
  const out = {};
  for (const u of urls) { try { const h = new URL(u).hostname.toLowerCase(); out[h] = (out[h] || 0) + 1; } catch {} }
  return out;
}

export async function crawl(startUrl, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Geçersiz URL: ${startUrl}`);
  const root = new URL(start);
  // v0.12.0: list mode. The tool asks only the given addresses of the site. It follows no link and reads no sitemap.
  // A redirect to another host is recorded but not requested: the requests stay on this site.
  const listMode = Array.isArray(o.seeds);
  if (listMode) o.useSitemap = false;
  const headers = { 'user-agent': o.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
  if (o.auth) headers.authorization = 'Basic ' + Buffer.from(o.auth).toString('base64');

  // v0.13.0: o.guard replaces the SSRF guard (test: block one loopback address and allow the test site).
  const guard = o.guard || (o.blockPrivate ? makeGuard() : null);

  // v0.10.1: the staging password goes only to the crawled site. A redirect or a sitemap on another host never gets it.
  const rootBare = bareHost(root.hostname);
  const headersFor = (url) => {
    if (!headers.authorization) return headers;
    let same = false;
    try { same = bareHost(new URL(url).hostname) === rootBare; } catch {}
    if (same) return headers;
    const { authorization, ...rest } = headers;
    return rest;
  };

  // v0.10.1: the timer stays active until the caller calls done(). So the timeout also covers the body.
  // v0.13.0: init { method, headers, body } for the render checkpoint. headersFor() still decides the password.
  async function request(url, init = {}) {
    if (guard) {
      const why = await guard(url);
      if (why) throw Object.assign(new Error(why), { cause: { code: why } });
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    const done = () => clearTimeout(timer);
    try {
      const res = await fetch(url, { method: init.method || 'GET', body: init.body, headers: { ...headersFor(url), ...(init.headers || {}) }, redirect: 'manual', signal: ctrl.signal });
      return { res, ms: Date.now() - t0, done, ctrl };
    } catch (e) { done(); throw e; }
  }

  // Reads the body as a stream and stops at maxBodyBytes: a huge page does not fill the memory.
  async function readBody(res, ctrl) {
    const chunks = []; let size = 0; let truncated = false;
    if (res.body) {
      for await (const chunk of res.body) {
        const room = o.maxBodyBytes - size;
        if (chunk.length >= room) { chunks.push(chunk.subarray(0, room)); size += room; truncated = true; break; }
        chunks.push(chunk); size += chunk.length;
      }
      if (truncated) ctrl.abort();
    }
    return { buf: Buffer.concat(chunks, size), truncated };
  }

  // Fetch one URL and follow redirects by hand, so every hop is recorded.
  async function fetchWithChain(url, { wantBody = true } = {}) {
    const chain = [];
    let current = url;
    let totalMs = 0;
    for (let i = 0; i <= o.maxRedirects; i++) {
      let r;
      try { r = await request(current); }
      catch (e) {
        return { chain, finalUrl: current, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message, ms: totalMs };
      }
      totalMs += r.ms;
      const { res } = r;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = normalizeUrl(loc, current);
        chain.push({ url: current, status: res.status, to: next });
        res.body?.cancel?.().catch(() => {});
        r.done();
        if (listMode && next && !isInternal(next, root.hostname)) return { chain, finalUrl: next, status: res.status, offHost: true, ms: totalMs };
        if (!next || chain.some((c) => c.url === next)) {
          return { chain, finalUrl: next || current, status: res.status, error: 'redirect-loop', ms: totalMs };
        }
        current = next;
        continue;
      }
      const ct = res.headers.get('content-type') || '';
      let body = null; let size = 0;
      const extra = { contentEncoding: res.headers.get('content-encoding') || '', hsts: res.headers.get('strict-transport-security') };
      let truncated = false;
      if (wantBody && /text\/html|application\/xhtml|xml|text\/plain|text\/markdown/i.test(ct)) {
        const tb = Date.now();
        let got;
        try { got = await readBody(res, r.ctrl); }
        catch (e) {
          // The headers came, the body did not: the page counts as failed (timeout or broken connection).
          r.done();
          return { chain, finalUrl: current, status: 0, error: r.ctrl.signal.aborted ? 'timeout' : e.cause?.code || e.message, ms: totalMs + (Date.now() - tb) };
        }
        size = got.buf.length; truncated = got.truncated;
        body = decodeBody(got.buf, ct);
      } else {
        res.body?.cancel?.().catch(() => {});
        size = Number(res.headers.get('content-length')) || 0;
      }
      r.done();
      return { chain, finalUrl: current, status: res.status, contentType: ct, xRobotsTag: res.headers.get('x-robots-tag') || '', body, size, ms: totalMs, ...(truncated ? { truncated: true } : {}), ...extra };
    }
    return { chain, finalUrl: current, status: 0, error: 'too-many-redirects', ms: totalMs };
  }

  const fetchText = async (url) => {
    const r = await fetchWithChain(url);
    return { status: r.status, body: r.body };
  };

  // robots.txt
  const robotsUrl = `${root.origin}/robots.txt`;
  const robotsRes = await fetchText(robotsUrl);
  const robotsTxt = robotsRes.status === 200 ? robotsRes.body || '' : '';
  const robots = robotsParser(robotsUrl, robotsTxt);
  const isBlocked = (url) => robots.isAllowed(url, o.userAgent) === false;

  // Sitemaps
  let sitemap = { urls: [], files: [] };
  if (o.useSitemap) {
    const smList = robots.getSitemaps().length ? robots.getSitemaps() : [`${root.origin}/sitemap.xml`];
    sitemap = await readSitemaps(smList, fetchText);
  }
  const sitemapSet = new Set(sitemap.urls);

  // v0.13.0: JavaScript render. If the browser does not open, the crawl goes on raw and meta.render.error says why.
  const renderCfg = { ...loadConfig().render, ...(o.render?.limits || {}) };
  const renderInfo = o.render && !listMode ? { enabled: true, pages: 0, failed: 0, ms: 0, limitReached: false, allowHosts: [...(o.render.allowHosts || [])] } : null;
  let renderer = null;
  if (renderInfo) {
    try {
      renderer = await createRenderer({
        rootHost: root.hostname, request, readBody, isBlocked, ignoreRobots: o.ignoreRobots, allowHosts: renderInfo.allowHosts,
        cfg: renderCfg, maxRedirects: o.maxRedirects, userAgent: o.userAgent, signal: o.signal,
      });
    } catch (e) { renderInfo.enabled = false; renderInfo.error = String(e.message || e).split('\n')[0].slice(0, 200); }
  }

  // Crawl state
  const pages = new Map();       // url -> record
  const queued = new Set();
  const linkQueue = [];          // { url, depth, foundOn, source }
  const sitemapQueue = [];

  function enqueue(url, depth, foundOn, source = 'link') {
    if (!url || !isInternal(url, root.hostname) || looksLikeAsset(url)) return;
    if (queued.has(url)) {
      // A sitemap URL found by a link: move it to the link queue so it gets a real depth.
      const i = source !== 'sitemap' ? sitemapQueue.findIndex((q) => q.url === url) : -1;
      if (i >= 0 && (depth == null || depth <= o.maxDepth)) {
        sitemapQueue.splice(i, 1);
        linkQueue.push({ url, depth, foundOn, source });
      }
      return;
    }
    if (depth != null && depth > o.maxDepth) return;
    queued.add(url);
    (source === 'sitemap' ? sitemapQueue : linkQueue).push({ url, depth, foundOn, source });
  }

  if (listMode) {
    for (const u of o.seeds) { const n = normalizeUrl(u); if (n && isInternal(n, root.hostname) && !queued.has(n)) { queued.add(n); linkQueue.push({ url: n, depth: null, foundOn: null, source: 'list' }); } }
  } else enqueue(start, 0, null, 'start');
  for (const u of sitemap.urls) if (isInternal(u, root.hostname)) {
    // Sitemap URLs are crawled after link discovery, so orphan pages are visible.
    if (!queued.has(u) && !looksLikeAsset(u)) { queued.add(u); sitemapQueue.push({ url: u, depth: null, foundOn: null, source: 'sitemap' }); }
  }

  let done = 0;
  async function processItem(item) {
    const rec = { url: item.url, depth: item.depth, foundOn: item.foundOn, discoveredBy: item.source, inSitemap: sitemapSet.has(item.url) };
    if (!o.ignoreRobots && isBlocked(item.url)) {
      Object.assign(rec, { status: null, blockedByRobots: true });
      pages.set(item.url, rec); return;
    }
    rec.blockedByRobots = false;
    const r = await fetchWithChain(item.url);
    Object.assign(rec, {
      status: r.chain.length ? r.chain[0].status : r.status,
      finalStatus: r.status,
      finalUrl: r.finalUrl,
      redirectChain: r.chain,
      error: r.error || null,
      contentType: r.contentType || '',
      xRobotsTag: r.xRobotsTag || '',
      responseMs: r.ms,
      sizeBytes: r.size || 0,
      contentEncoding: r.contentEncoding || '',
      ...(r.truncated ? { truncated: true } : {}),
      ...(r.offHost ? { offHost: true } : {}),
      ...(r.finalUrl?.startsWith('https:') && !r.chain.length ? { hsts: r.hsts || '' } : {}),
    });

    if (listMode) {
      // List mode: read the page, follow nothing.
      if (!r.chain.length && r.body && /html/i.test(r.contentType) && r.status < 400) Object.assign(rec, parsePage(r.body, item.url, root.hostname));
    } else if (r.chain.length) {
      // Redirecting URL: crawl the target as its own page.
      const d = item.depth == null ? null : item.depth + 1;
      enqueue(r.finalUrl, d, item.url, 'redirect');
    } else if (r.body && /html/i.test(r.contentType) && r.status < 400) {
      const p = parsePage(r.body, item.url, root.hostname);
      Object.assign(rec, p);
      if (renderer && r.status === 200) {
        if (renderInfo.pages >= renderCfg.maxPages) { renderInfo.limitReached = true; rec.render = { skipped: 'limit' }; }
        else {
          renderInfo.pages++;
          const { html, ...info } = await renderer.render(item.url, r.body);
          renderInfo.ms += info.ms;
          rec.render = info;
          if (html && !info.error) { Object.assign(rec, mergeRender(p, html, item.url, root.hostname)); rec.rendered = true; }
          else { renderInfo.failed++; rec.rendered = false; }
        }
      }
      const nd = item.depth == null ? null : item.depth + 1;
      for (const l of rec.links) if (l.internal) enqueue(l.url, nd, item.url, 'link');
      if (rec.canonical) enqueue(rec.canonical, nd, item.url, 'canonical');
      if (p.canonical && p.canonical !== rec.canonical) enqueue(p.canonical, nd, item.url, 'canonical');
      for (const h of rec.hreflang) if (h.url) enqueue(h.url, nd, item.url, 'hreflang');
    }
    pages.set(item.url, rec);
  }

  async function worker() {
    while (pages.size + inFlight.size < o.maxUrls && !o.signal?.aborted) {
      // Sitemap-only URLs wait until link discovery is finished.
      const item = linkQueue.shift() || (linkInFlight === 0 ? sitemapQueue.shift() : null);
      if (!item) {
        if (inFlight.size === 0 && !sitemapQueue.length) return;
        await sleep(50); continue;
      }
      const isLink = item.source !== 'sitemap';
      inFlight.add(item.url);
      if (isLink) linkInFlight++;
      try { await processItem(item); }
      catch (e) { pages.set(item.url, { url: item.url, depth: item.depth, status: 0, error: String(e.message || e) }); }
      finally { inFlight.delete(item.url); if (isLink) linkInFlight--; }
      done++;
      const rec = pages.get(item.url);
      o.onProgress?.({ done, queued: linkQueue.length + sitemapQueue.length, url: item.url, status: rec?.status ?? null, blocked: !!rec?.blockedByRobots });
      if (o.delayMs) await sleep(o.delayMs);
    }
  }
  const inFlight = new Set();
  let linkInFlight = 0;
  const startedAt = new Date().toISOString();
  try { await Promise.all(Array.from({ length: o.concurrency }, worker)); }
  finally { if (renderer) await renderer.close(); }

  // Inlink counts (internal links only, unique per source page).
  const inlinks = new Map();
  for (const p of pages.values()) {
    for (const u of new Set((p.links || []).filter((l) => l.internal).map((l) => l.url))) {
      inlinks.set(u, (inlinks.get(u) || 0) + 1);
    }
  }
  const list = [...pages.values()].map((p) => ({
    ...p,
    inlinks: inlinks.get(p.url) || 0,
    orphan: p.discoveredBy === 'sitemap' && !inlinks.get(p.url),
  }));
  const finishedCrawl = new Date().toISOString();

  // Extra checks run after the crawl and only when asked for.
  let checks = null;
  if (o.checks && !o.signal?.aborted) {
    const want = o.checks === true ? {} : o.checks;
    const enabled = { site: want.site !== false, external: want.external !== false, images: want.images !== false };
    checks = await runChecks({
      start, root, pages: list, fetchWithChain, headers, enabled, variants: want.variants, guard,
      cfg: { ...loadConfig().checks, ...(want.limits || {}) }, signal: o.signal, onProgress: o.onChecks,
    });
  }

  return {
    meta: {
      tool: 'seo-audit', version: VERSION,
      startUrl: start, host: root.hostname,
      startedAt, crawlFinishedAt: finishedCrawl, finishedAt: new Date().toISOString(),
      options: { ...o, guard: undefined, auth: o.auth ? '***' : null, render: o.render ? { allowHosts: [...(o.render.allowHosts || [])] } : false, onProgress: undefined, onChecks: undefined, signal: undefined, checks: o.checks ? { ...(o.checks === true ? {} : o.checks), variants: undefined } : false },
      robots: { url: robotsUrl, status: robotsRes.status, sitemaps: robots.getSitemaps(), body: robotsTxt.slice(0, 20000) },
      // v0.10.0: hosts of the sitemap URLs (also hosts that are not crawled). The launch list finds staging addresses here.
      sitemap: { files: sitemap.files, urlCount: sitemap.urls.length, hosts: sitemapHosts(sitemap.urls) },
      limitReached: list.length >= o.maxUrls,
      cancelled: !!o.signal?.aborted,
      notCrawled: [...linkQueue, ...sitemapQueue].length,
      ...(renderInfo ? { render: renderInfo } : {}),
    },
    pages: list,
    checks,
  };
}
