// Web interface: start crawls, watch progress live, browse results, download Excel.
import http from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from './crawler.js';
import { exportExcel, exportCompareExcel } from './export.js';
import { compareCrawls, probeLost, parseRules, sectionTable } from './compare.js';
import { ProjectStore, PID_RE, validateProject, engineRules, cleanMap } from './projects.js';
import { buildRedirectMap, mapCsv } from './redirectmap.js';
import { Store, ID_RE } from './store.js';
import { normalizeUrl } from './normalize.js';
import { runAudit, loadConfig, RULES, CATEGORIES } from './rules/index.js';
import { isBroken, isOk } from './rules/helpers.js';
import { buildTodo } from './todo.js';
import { buildLaunch, makeIsStaging } from './launch.js';
import { expectedList, checkRedirects, buildVerify, makeRequest, hostKey } from './verify.js';
import { readList, cleanList, makeSource, mergeSources, validateList, rowCount, toFetch, withListPages, latePaths, withLatePages, listResults, sourceSummary, oldRedirects, KIND_NAME } from './urllist.js';
import { createHash } from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import { makeGuard } from './netguard.js';
import { readFileSync } from 'node:fs';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +(process.env.PORT || 3300);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JOBS = +(process.env.MAX_JOBS || 2);
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;

// PUBLIC_MODE=1: the server is open to the internet (Render). Private addresses are blocked and limits from
// config/rules.json → yayin apply. v0.8.4 (user decision): the password is optional. Without APP_PASS the server
// starts open to everyone and writes a warning. With APP_PASS, APP_USER and the minimum length are still required.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const EPHEMERAL = process.env.EPHEMERAL_STORAGE === '1';
const YAYIN = loadConfig().yayin;
if (PUBLIC_MODE && APP_PASS && (!APP_USER || APP_PASS.length < YAYIN.minPassLength)) {
  console.error(`HATA: APP_PASS tanımlı ise APP_USER ve en az ${YAYIN.minPassLength} karakterli APP_PASS gerekli. Sunucu başlamadı.`);
  process.exit(1);
}
if (PUBLIC_MODE && !APP_PASS) console.log('UYARI: Yayın modu şifresiz. Herkes projeleri görür, indirir ve siler. Müşteri sitesi taramayın.');
const JOB_LIMIT = PUBLIC_MODE ? YAYIN.maxJobs : MAX_JOBS;
const URL_LIMIT = PUBLIC_MODE ? YAYIN.maxUrls : 50000;
const startGuard = PUBLIC_MODE ? makeGuard() : null;

// v0.10.1: request checks for the browser.
// Host: on a local server the Host header must be localhost, an IP address or a name in ALLOWED_HOSTS. A foreign
// name means DNS rebinding: a web page reads the local crawls through its own domain. A public server skips this check.
// Origin: a write request (POST, PUT, DELETE) from a browser must come from the page of this server, not from another site.
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const hostName = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
function hostAllowed(req) {
  if (PUBLIC_MODE) return true;
  const h = hostName(req.headers.host);
  return h === 'localhost' || net.isIP(h) !== 0 || ALLOWED_HOSTS.has(h);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || !['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return true;
  try {
    const o = new URL(origin).host.toLowerCase();
    return o === String(req.headers.host || '').toLowerCase() || ALLOWED_HOSTS.has(hostName(o));
  } catch { return false; }
}

// Comparison results are cached per crawl pair: probing old paths on the new host takes time.
const cmpCache = new Map();
// The cache key holds the crawl ids and the rules, so a new rule set runs a new comparison.
// live: { crawl host → live host } of the target sites (project only).
// v0.10.1: a result is used for compare.probeCacheMin minutes. fresh: true asks every address again
// (the developer set up the 301s, the user wants the new state without a new crawl).
async function compareWithProbe(a, ids, oldRes, newList, rules, cc, live = {}, { fresh = false } = {}) {
  const key = `${a}|${ids.join(',')}|${JSON.stringify(rules.map((r) => r.text))}|${JSON.stringify(live)}`;
  const hit = cmpCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < (cc.probeCacheMin ?? 30) * 60_000) return hit.cmp;
  const cmp = compareCrawls(oldRes, newList, {
    rules, live, suggest: { minPages: cc.suggestMinPages, minRatio: cc.suggestMinRatio, max: cc.maxSuggestions },
  });
  const guard = PUBLIC_MODE ? makeGuard() : null;
  const cfg = loadConfig().checks;
  const request = async (url) => {
    if (guard && await guard(url)) throw Object.assign(new Error('blocked-private'), { cause: { code: 'blocked-private' } });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': `SEO-Audit/${VERSION}` } });
      res.body?.cancel?.();
      return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '' };
    } catch (e) { throw e.name === 'AbortError' ? Object.assign(new Error('timeout'), { cause: { code: 'timeout' } }) : e; }
    finally { clearTimeout(t); }
  };
  await probeLost(cmp, request, { concurrency: cfg.concurrency });
  cmp.checkedAt = new Date().toISOString();
  cmpCache.delete(key);
  cmpCache.set(key, { cmp, at: Date.now() });
  if (cmpCache.size > 20) cmpCache.delete(cmpCache.keys().next().value);
  return cmp;
}

const CRAWL_DIR = process.env.CRAWL_DIR || path.join(ROOT, 'crawls');
const store = new Store(CRAWL_DIR);
await store.init();
const projects = new ProjectStore(path.join(CRAWL_DIR, 'projects'));
await projects.init();

const jobs = new Map(); // id -> { id, label, url, status, progress, counts, clients:Set, controller, error }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

// The size limit is in config/rules.json → server.maxBodyKb. A project file with many 301 decisions is large.
async function readJson(req) {
  const max = (loadConfig().server?.maxBodyKb ?? 4096) * 1024;
  const chunks = []; let size = 0;
  // A request over the limit is read to its end without keeping it: the browser gets the answer, the connection stays usable.
  // A request far over the limit is cut.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max * 4) { req.destroy(); break; }
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) throw Object.assign(new Error(`İstek çok büyük. Sınır ${Math.round(max / 1024)} KB.`), { code: 413 });
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('İstek okunamadı. Geçerli bir JSON gönderin.'), { code: 400 }); }
}

function broadcast(job, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of job.clients) c.write(msg);
}

function bucket(p) {
  if (p.blocked) return 'blocked';
  const s = p.status;
  if (!s) return 'failed';
  if (s >= 500) return 'server';
  if (s >= 400) return 'client';
  if (s >= 300) return 'redirect';
  return 'ok';
}

function publicJob(j) {
  return { id: j.id, label: j.label, url: j.url, status: j.status, progress: j.progress, counts: j.counts, error: j.error, startedAt: j.startedAt };
}

// Returns the saved audit, or re-runs it when rules.json or the engine changed.
async function getAudit(id, result) {
  const cfg = loadConfig();
  let audit = await store.loadAudit(id);
  if (!audit || audit.configHash !== cfg.hash) {
    audit = runAudit(result || await store.load(id), cfg);
    await store.saveAudit(id, audit);
    await store.updateMeta(id, { score: audit.score, issueCounts: audit.counts });
  }
  return audit;
}


// ---------- Projects (v0.7.0) ----------
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const projectLimits = () => { const c = loadConfig(); return { maxExtras: c.compare.maxTargets - 1, maxRules: c.compare.maxRules, maxDecisions: c.redirectMap.maxDecisions }; };

// State of every site: none (not crawled), running, done, deleted (crawl file gone), stale (address changed).
// v0.11.0: every target site also gets "live": the state of its live crawl (after launch), kept apart from the staging crawl.
async function projectStatus(p) {
  const out = {};
  const origins = p.launch ? await liveOrigins(p) : {};
  for (const site of p.sites) {
    out[site.key] = await crawlState(site);
    if (site.role !== 'old') out[site.key].live = await liveState(site, origins[site.key] || null);
  }
  return out;
}
async function crawlState(site) {
  const job = site.pendingCrawlId && jobs.get(site.pendingCrawlId);
  if (job && job.status === 'running') return { state: 'running', jobId: job.id, done: job.progress.done, phase: job.progress.phase || 'crawl' };
  if (!site.crawlId) return { state: 'none', error: site.lastError || null };
  const m = await store.meta(site.crawlId);
  if (!m) return { state: 'deleted', crawlId: site.crawlId };
  const urlHost = site.url ? bareHost(new URL(site.url).hostname) : '';
  return {
    state: urlHost && bareHost(m.host) !== urlHost ? 'stale' : 'done',
    crawlId: m.id, host: m.host, startedAt: m.startedAt, pages: m.summary.total, ok: m.summary.ok,
    blocked: m.summary.blocked, limitReached: !!m.limitReached, cancelled: !!m.cancelled, error: site.lastError || null,
  };
}
// Live crawl of a target site. stale: the crawl is on another domain than the live domain of the project now.
async function liveState(site, origin) {
  const job = site.pendingLiveCrawlId && jobs.get(site.pendingLiveCrawlId);
  if (job && job.status === 'running') return { state: 'running', jobId: job.id, done: job.progress.done, origin };
  if (!site.liveCrawlId) return { state: 'none', error: site.liveError || null, origin };
  const m = await store.meta(site.liveCrawlId);
  if (!m) return { state: 'deleted', crawlId: site.liveCrawlId, origin };
  return { state: origin && hostKey(m.startUrl) !== hostKey(origin) ? 'stale' : 'done', crawlId: m.id, host: m.host, startedAt: m.startedAt,
    pages: m.summary.total, ok: m.summary.ok, limitReached: !!m.limitReached, error: site.liveError || null, origin };
}
// Live origin of every target site: the heir takes the old domain, an extra site its "live domain" (null: not written).
// The old origin comes from the old crawl (it keeps http/https and www as the old site had them).
async function liveOrigins(p) {
  const old = p.sites.find((s) => s.role === 'old');
  const m = old.crawlId ? await store.meta(old.crawlId) : null;
  let base;
  try { base = new URL(m?.startUrl || old.url); } catch { return {}; }
  const out = {};
  for (const s of p.sites) if (s.role !== 'old') out[s.key] = s.role === 'heir' ? base.origin : s.live ? `${base.protocol}//${s.live}` : null;
  return out;
}

// ---------- Old address list (v0.12.0) ----------
// State of the list crawl: none, running, done, deleted.
async function listState(p) {
  const L = p.urlList || {};
  const job = L.pendingCrawlId && jobs.get(L.pendingCrawlId);
  if (job && job.status === 'running') return { state: 'running', jobId: job.id, done: job.progress.done, total: job.total || 0 };
  if (!L.crawlId) return { state: 'none', error: L.lastError || null };
  const m = await store.meta(L.crawlId);
  if (!m) return { state: 'deleted', crawlId: L.crawlId, error: L.lastError || null };
  return { state: 'done', crawlId: m.id, startedAt: m.startedAt, asked: m.summary.total, error: L.lastError || null };
}
// The list screen: sources, counts by result and the rows (traffic order, up to urlList.listLimit).
async function listView(p) {
  const cfg = loadConfig().urlList || {};
  const list = await projects.getList(p.id);
  const merged = mergeSources(list.sources);
  const state = await listState(p);
  const old = p.sites.find((s) => s.role === 'old');
  let oldRes = null;
  if (old.crawlId) { try { oldRes = await store.load(old.crawlId); } catch {} }
  let listRes = null;
  if (state.state === 'done') { try { listRes = await store.load(state.crawlId); } catch {} }
  const max = PUBLIC_MODE ? YAYIN.maxUrls : Infinity;
  const want = oldRes ? toFetch(merged, oldRes, max) : null;
  const R = listResults({ merged, oldRes, listRes, launched: !!p.launch, limitPaths: want?.rest });
  // open: addresses still to ask (not in the old crawl, not asked by the last list crawl: a source came after it).
  const open = R.counts.pending;
  return {
    ...sourceSummary(list), addresses: merged.size, state, counts: R.counts, open, launched: !!p.launch,
    needOld: !oldRes, toAsk: want ? want.urls.length : 0, limit: Number.isFinite(max) ? max : null,
    rows: R.rows.slice(0, cfg.listLimit ?? 200), more: Math.max(0, R.rows.length - (cfg.listLimit ?? 200)),
  };
}
const LIST_LOCKED = 'Site canlıya çıktı. Eski alan adı yeni siteyi sunar. Araç eski sitede istek atmaz.';
async function startListFetch(id, options = {}) {
  const p = await projects.get(id);
  if (p.launch) throw Object.assign(new Error(LIST_LOCKED), { code: 409, need: ['no-launch'] });
  const st = await listState(p);
  if (st.state === 'running') throw Object.assign(new Error('Liste adresleri zaten isteniyor.'), { code: 409 });
  const old = p.sites.find((s) => s.role === 'old');
  if (!old.crawlId) throw Object.assign(new Error('Eski site taranmadı. Önce eski siteyi tarayın.'), { code: 409, need: ['old'] });
  let oldRes;
  try { oldRes = await store.load(old.crawlId); } catch { throw Object.assign(new Error('Eski site taraması silinmiş. Eski siteyi tekrar tarayın.'), { code: 409, need: ['old'] }); }
  const merged = mergeSources((await projects.getList(id)).sources);
  if (!merged.size) throw Object.assign(new Error('Listede adres yok. Önce liste ekleyin.'), { code: 400 });
  const want = toFetch(merged, oldRes, PUBLIC_MODE ? YAYIN.maxUrls : Infinity);
  if (!want.urls.length) throw Object.assign(new Error('İstenecek adres yok. Listedeki bütün adresler eski site taramasında var.'), { code: 400 });
  // The requests go only to the old site (the crawler's list mode never leaves the host). Public mode: SSRF guard.
  const job = await startJob({ url: oldRes.meta.startUrl, label: 'liste', options: { ignoreRobots: !!options.ignoreRobots, checks: false } }, { seeds: want.urls });
  await projects.update(id, (q) => ({ ...q, urlList: { ...(q.urlList || {}), pendingCrawlId: job.id, lastError: null } }));
  job.finished.then((r) => projects.update(id, (q) => {
    const L = { ...(q.urlList || {}) };
    if (L.pendingCrawlId !== job.id) return;
    L.pendingCrawlId = null;
    if (r.status === 'error') L.lastError = r.error;
    else if (q.launch) L.lastError = 'İstekler çıkış işaretinden sonra bitti. Kilit nedeniyle projeye bağlanmadı.';
    else { L.crawlId = job.id; L.lastError = null; }
    return { ...q, urlList: L };
  })).catch((e) => console.error('Proje güncellenemedi:', e.message));
  return job;
}
// Adds one source. preview: read and clean, do not save (the screen shows the columns first).
async function addListSource(id, body) {
  const cfg = loadConfig().urlList || {};
  const p = await projects.get(id);
  const old = p.sites.find((s) => s.role === 'old');
  const m = old.crawlId ? await store.meta(old.crawlId) : null;
  const start = m?.startUrl || old.url;
  if (!start) throw Object.assign(new Error('Eski sitenin adresi yok. Proje adımında yazın.'), { code: 400 });
  const chosen = body.columns && typeof body.columns === 'object' ? body.columns : null;
  const r = readList(body.text, cfg, chosen);
  const cleaned = cleanList(r.rows, start);
  const list = await projects.getList(id);
  const info = { kind: r.kind, kindName: KIND_NAME[r.kind], columns: r.columns, header: r.header, rows: r.rows.length, addresses: cleaned.urls.size,
    other: Object.values(cleaned.other).reduce((a, b) => a + b, 0), invalid: cleaned.invalid, assets: cleaned.assets, merged: cleaned.merged };
  if (!cleaned.urls.size) throw Object.assign(new Error(info.other ? `Listede eski alan adının adresi yok. ${info.other} adres başka alan adında.` : 'Listede okunabilen adres yok.'), { code: 400, columns: r.header });
  if (body.preview) return { preview: info };
  const src = makeSource({ text: body.text, name: body.name, file: body.file, kind: r.kind, columns: r.columns, cleaned, rows: r.rows.length }, `l${Date.now().toString(36)}`);
  if (p.launch) src.afterLaunch = true;
  await projects.updateList(id, (L) => {
    if (L.sources.length >= (cfg.maxSources ?? 5)) throw Object.assign(new Error(`En fazla ${cfg.maxSources ?? 5} liste eklenir. Önce bir listeyi kaldırın.`), { code: 400 });
    if (L.sources.some((x) => x.hash === src.hash)) throw Object.assign(new Error('Bu liste zaten ekli.'), { code: 409 });
    if (rowCount(L) + src.urls.length > (cfg.maxRows ?? 30000)) throw Object.assign(new Error(`Listede en fazla ${cfg.maxRows ?? 30000} adres saklanır. Daha kısa bir liste ekleyin (en çok trafik alan satırlar).`), { code: 400 });
    return { ...L, version: 1, sources: [...L.sources, src] };
  });
  return { added: info };
}

// Starts a crawl for one site of a project. The crawl id is written to the project when the crawl ends.
// v0.11.0: after launch the crawls before launch are locked: the old domain now serves the new site, so a new crawl
// of the old site would lose the old pages. live: true crawls a target site on its live domain (a separate crawl id).
const LOCKED = 'Site canlıya çıktı. Çıkış öncesi taramalar kilitli: eski site taraması çıkıştan önceki hali tutar. Canlı tarama için Canlı doğrulama adımını açın.';
async function startProjectCrawl(id, key, options, { live = false } = {}) {
  const p = await projects.get(id);
  const site = p.sites.find((s) => s.key === key);
  if (!site) throw Object.assign(new Error('Site projede yok.'), { code: 404 });
  let url = site.url, label = site.role === 'old' ? 'eski' : 'yeni';
  if (live) {
    if (!p.launch) throw Object.assign(new Error('Önce çıkışı işaretleyin. Canlı tarama çıkıştan sonra yapılır.'), { code: 409 });
    if (site.role === 'old') throw Object.assign(new Error('Eski site canlıda taranmaz. Eski alan adını geçecek site kullanır.'), { code: 400 });
    const origin = (await liveOrigins(p))[key];
    if (!origin) throw Object.assign(new Error('Bu sitenin canlı alan adı yok. Proje adımında yazın.'), { code: 400 });
    url = `${origin}/`; label = 'canli';
  } else {
    if (p.launch) throw Object.assign(new Error(LOCKED), { code: 409 });
    if (!site.url) throw Object.assign(new Error('Önce sitenin adresini yazın.'), { code: 400 });
  }
  const F = live ? { pend: 'pendingLiveCrawlId', id: 'liveCrawlId', err: 'liveError' } : { pend: 'pendingCrawlId', id: 'crawlId', err: 'lastError' };
  const job = await startJob({ url, label, options });
  await projects.update(id, (q) => { const s = q.sites.find((x) => x.key === key); if (s) { s[F.pend] = job.id; s[F.err] = null; } });
  job.finished.then((r) => projects.update(id, (q) => {
    const s = q.sites.find((x) => x.key === key);
    if (!s || s[F.pend] !== job.id) return;
    s[F.pend] = null;
    if (r.status === 'error') s[F.err] = r.error;
    else if (!live && q.launch) s[F.err] = 'Tarama çıkış işaretinden sonra bitti. Kilit nedeniyle projeye bağlanmadı.';
    else { s[F.id] = job.id; s[F.err] = null; }
  })).catch((e) => console.error('Proje güncellenemedi:', e.message));
  return job;
}

// Display names of the project sites (Excel). The heir and the old site have fixed names.
function siteNames(p) {
  const out = { old: 'Eski site' };
  for (const s of p.sites) if (s.role !== 'old') out[s.key] = s.role === 'heir' ? 'Eski alan adına geçecek site' : s.name || 'Ek site';
  return out;
}

// Inputs of the matching: crawls, rules (the user's and the suggested moves), live hosts, sites of the 301 map.
// No requests here. v0.11.0: shared by the matching and the live check.
async function projectInputs(p, status) {
  const cc = loadConfig().compare;
  const old = p.sites.find((s) => s.role === 'old'), heir = p.sites.find((s) => s.role === 'heir');
  const missing = [old, heir].filter((s) => status[s.key].state !== 'done' && status[s.key].state !== 'stale');
  if (missing.length) {
    const names = missing.map((s) => (s.role === 'old' ? 'Eski site' : 'Eski alan adına geçecek site'));
    throw Object.assign(new Error(`${names.join(' ve ')} taranmadı. Eşleştirme için gerekli.`), { code: 409, need: missing.map((s) => s.key) });
  }
  const targets = [heir, ...p.sites.filter((s) => s.role === 'extra' && ['done', 'stale'].includes(status[s.key].state))];
  const ids = targets.map((s) => status[s.key].crawlId);
  const [oldCrawl, ...newList] = await Promise.all([status[old.key].crawlId, ...ids].map((x) => store.load(x)));
  // v0.12.0: the old address list. Pages of the list crawl that answered with HTML 200 join the old page set.
  // Every step after this (matching, 301 map, work list, launch list, live check) uses them like crawled pages.
  const L = await listInputs(p, oldCrawl);
  const oldRes = L.oldRes;
  const hostOf = (key) => {
    const s = p.sites.find((x) => x.key === key);
    return status[key]?.host ? bareHost(status[key].host) : s?.url ? bareHost(new URL(s.url).hostname) : '';
  };
  const keyOfHost = (h) => (!h ? 'heir' : p.sites.find((s) => s.role !== 'old' && hostOf(s.key) === bareHost(h))?.key || null);
  const live = {};
  for (const s of targets) if (s.live) live[hostOf(s.key)] = s.live;
  const suggest = { minPages: cc.suggestMinPages, minRatio: cc.suggestMinRatio, max: cc.maxSuggestions };
  const userRules = parseRules(engineRules(p, hostOf), cc.maxRules);
  // First pass without requests: which sections have a suggested move?
  const first = compareCrawls(oldRes, newList, { rules: userRules, live, suggest });
  const auto = first.suggestions.filter((x) => !x.notFound).map(({ from, host, to }) => ({ from, host, to }));
  const rules = parseRules([...userRules.map(({ from, host, to, drop }) => ({ from, host, to, drop })), ...auto], cc.maxRules + cc.maxSuggestions);
  // 301 map (v0.8.0): heir first. The heir takes the old domain, so its live origin is the old origin.
  const oldOrigin = new URL(oldRes.meta.startUrl);
  const mapSites = targets.map((s, i) => {
    const res = newList[i];
    return { key: s.key, host: res.meta.host, origin: new URL(res.meta.startUrl).origin, pages: res.pages,
      liveOrigin: s.role === 'heir' ? oldOrigin.origin : s.live ? `${oldOrigin.protocol}//${s.live}` : null };
  });
  return { cc, old, heir, targets, ids, oldRes, newList, keyOfHost, live, rules, auto, mapSites, list: L };
}

// Old address list of a project with the old crawl: merged list, list crawl, old page set with the list pages.
// key: changes when the pages added from the list change (the comparison cache uses it).
async function listInputs(p, oldCrawl) {
  const list = await projects.getList(p.id);
  const merged = mergeSources(list.sources);
  const id = p.urlList?.crawlId || null;
  let listRes = null;
  if (id && merged.size) { try { listRes = await store.load(id); } catch {} }
  // v0.12.1 (decision 7b): after launch the list addresses the old site never answered join as old pages without
  // content (late: true). No step sends them to the old site or to staging; the live check asks the live domain.
  const late = p.launch && merged.size ? latePaths(merged, oldCrawl, listRes) : new Set();
  const oldRes = withLatePages(withListPages(oldCrawl, listRes, merged), late);
  const added = oldRes.pages.length - oldCrawl.pages.length;
  const key = added ? createHash('sha1').update(oldRes.pages.slice(oldCrawl.pages.length).map((x) => (x.late ? `late ${x.url}` : x.url)).join('\n')).digest('hex').slice(0, 12) : '';
  // v0.12.2: redirects of the old site (old crawl and list crawl, before launch). Not old pages: they get 301 map rows
  // that follow their target. No request: the data comes from the crawls.
  const redirects = oldRedirects(oldCrawl, listRes, merged);
  return { list, merged, listRes, oldCrawl, oldRes, added, key, late, redirects };
}

// Matching of a project: old site → heir and other sites. Sections without a decision get the suggested move.
async function projectMatch(p, { fresh = false } = {}) {
  const status = await projectStatus(p);
  const { cc, old, targets, ids, oldRes, newList, keyOfHost, live, rules, auto, mapSites, list } = await projectInputs(p, status);
  const cmp = await compareWithProbe(`${status[old.key].crawlId}${list.key ? `+${list.key}` : ''}`, ids, oldRes, newList, rules, cc, live, { fresh });
  const autoFrom = new Set(auto.map((a) => a.from));
  const sections = sectionTable(cmp, { minPages: cc.suggestMinPages, pageLimit: cc.sectionPageLimit, langMinShare: cc.langMinShare }).map((sec) => ({
    ...sec, auto: autoFrom.has(sec.from),
    current: sec.current.drop ? sec.current : { site: keyOfHost(sec.current.host), to: sec.current.to },
    options: sec.options.map((o) => ({ site: keyOfHost(o.host), to: o.to, hits: o.hits, lang: o.lang })).filter((o) => o.site),
    // v0.8.1: the decision is probably wrong (language or no page found). better: the choice to use instead.
    alert: sec.alert && keyOfHost(sec.alert.better.host) ? { ...sec.alert, better: { site: keyOfHost(sec.alert.better.host), to: sec.alert.better.to, hits: sec.alert.better.hits } } : null,
    // notFound: no move finds the pages. A weak hint (site, to, hits) may come with it. It is never applied by itself.
    suggestion: sec.suggestion && (sec.suggestion.notFound
      ? { notFound: true, hits: sec.suggestion.hits, why: sec.suggestion.why, ...(sec.suggestion.to ? { site: keyOfHost(sec.suggestion.host), to: sec.suggestion.to } : {}) }
      : { site: keyOfHost(sec.suggestion.host), to: sec.suggestion.to, why: sec.suggestion.why }),
  }));
  const map = buildRedirectMap(cmp, oldRes, mapSites, p.map || {}, loadConfig().redirectMap, list.merged.size ? list.merged : null, { redirects: list.redirects, staging: loadConfig() });
  map.noLive = mapSites.filter((s) => !s.liveOrigin).map((s) => s.key);
  // Work list by place (v0.9.0). A thin site (few pages) is "not ready" until the user accepts its crawl.
  const traffic = list.merged.size ? list.merged : null;
  const todo = buildTodo({ cmp, map, sections, oldHost: oldRes.meta.host, readyOk: p.readyOk || {}, cfg: loadConfig().todo || {}, traffic,
    sites: targets.map((s, i) => ({ key: s.key, role: s.role, name: s.name, host: newList[i].meta.host, origin: mapSites[i].origin, liveOrigin: mapSites[i].liveOrigin,
      okPages: newList[i].pages.filter(isOk).length, crawlId: status[s.key].crawlId })) });
  // Launch list (v0.10.0): staging checks of every target site, the 301 list and the tags of the old site.
  const launch = buildLaunch({ oldRes, map, cfg: loadConfig(),
    sites: targets.map((s, i) => ({ key: s.key, role: s.role, res: newList[i], liveOrigin: mapSites[i].liveOrigin })) });
  // v0.12.0: result of every list address (Excel sheet "Eski adres listesi").
  const urlList = list.merged.size ? listResults({ merged: list.merged, oldRes: list.oldCrawl, listRes: list.listRes, launched: !!p.launch }) : null;
  return { cmp, sections, targets: targets.map((s) => s.key), status, map, todo, launch, urlList };
}

// Live check (v0.11.0, Part 3b). The expected list comes from the crawls before launch and the decisions (no staging
// requests). Every old address is asked on the live old domain; hops go only to the live domains of the project.
// The answers are kept compare.probeCacheMin minutes per project; fresh: true asks again ("Tekrar kontrol et").
// A new decision changes the expected list, so it is checked again at once.
const verifyCache = new Map(); // project id → { key, at, checked }
async function projectVerify(p, { fresh = false } = {}) {
  if (!p.launch) throw Object.assign(new Error('Çıkış işaretlenmedi. Site canlıya çıkınca "Canlıya çıktık" düğmesine basın.'), { code: 409, need: ['launch'] });
  const cfg = loadConfig();
  const status = await projectStatus(p);
  const { targets, oldRes, newList, rules, live, mapSites, list } = await projectInputs(p, status);
  const { rows } = expectedList({ oldRes, newList, sites: mapSites, rules, live, decisions: p.map || {}, cfg, traffic: list.merged.size ? list.merged : null, redirects: list.redirects });
  const info = targets.map((s, i) => {
    const host = bareHost(newList[i].meta.host), liveHost = mapSites[i].liveOrigin ? bareHost(new URL(mapSites[i].liveOrigin).hostname) : '';
    return { host, liveHost, staging: !liveHost || host !== liveHost };
  });
  const isStg = makeIsStaging(info, cfg);
  const allowed = new Set([hostKey(oldRes.meta.startUrl), ...mapSites.filter((s) => s.liveOrigin).map((s) => hostKey(s.liveOrigin))]);
  // v0.12.1: the key does not depend on the row order or the traffic. A new list source changes the order, not the answers.
  const key = createHash('sha1').update(JSON.stringify([rows.map((r) => [r.oldUrl, r.expect, r.target || '', !!r.noLive, r.late ? !!r.proof : null]).sort((a, b) => a[0].localeCompare(b[0])), [...allowed].sort()])).digest('hex');
  const hit = verifyCache.get(p.id);
  let checked, at;
  if (hit && !fresh && hit.key === key && Date.now() - hit.at < (cfg.compare.probeCacheMin ?? 30) * 60_000) ({ checked, at } = hit);
  else {
    const request = makeRequest({ guard: PUBLIC_MODE ? makeGuard() : null, timeoutMs: cfg.checks.timeoutMs, userAgent: `SEO-Audit/${VERSION}` });
    checked = await checkRedirects(rows, request, { allowed, isStg, concurrency: cfg.checks.concurrency, maxHops: cfg.verify?.maxHops ?? 5,
      maxChecks: PUBLIC_MODE ? cfg.yayin.maxUrls : Infinity });
    at = Date.now();
    verifyCache.delete(p.id);
    verifyCache.set(p.id, { key, at, checked });
    if (verifyCache.size > 20) verifyCache.delete(verifyCache.keys().next().value);
  }
  // The answers in the current row order with the current traffic (a cached answer may come from another order).
  const answer = new Map(checked.map((c) => [c.oldUrl, c]));
  checked = rows.map((r) => ({ ...answer.get(r.oldUrl), traffic: r.traffic }));
  // Every target site gets a card, also one without a crawl before launch.
  const origins = await liveOrigins(p);
  const liveSites = await Promise.all(p.sites.filter((s) => s.role !== 'old').map(async (s) => {
    const L = status[s.key].live || { state: 'none' };
    let res = null, state = L.state;
    if (state === 'done') { try { res = await store.load(L.crawlId); } catch { state = 'deleted'; } }
    return { key: s.key, role: s.role, name: s.name, liveOrigin: origins[s.key] || null, state, res, jobId: L.jobId, done: L.done, startedAt: L.startedAt };
  }));
  const V = buildVerify({ checked, liveSites, oldRes, isStg, cfg });
  return { ...V, checkedAt: new Date(at).toISOString(), launch: p.launch, status };
}

// extra.seeds (v0.12.0): list mode. The crawler asks only these addresses (old address list). No audit.
async function startJob(body, extra = {}) {
  const url = normalizeUrl(String(body.url || '').trim());
  if (!url) throw Object.assign(new Error('Geçerli bir adres yazın. Örnek: https://www.ornek.com'), { code: 400 });
  if (startGuard && await startGuard(url)) throw Object.assign(new Error('Bu adres bir iç ağ adresi. Yayındaki sunucu iç ağ adreslerini taramaz.'), { code: 400 });
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  if (running >= JOB_LIMIT) throw Object.assign(new Error(`Aynı anda en fazla ${JOB_LIMIT} tarama çalışır. Bir taramanın bitmesini bekleyin.`), { code: 429 });

  const label = String(body.label || '').replace(/[^\w-]/g, '').slice(0, 20);
  const host = new URL(url).hostname;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // v0.10.1: the id is a file name. An IPv6 host ("[::1]") has characters a file name must not have.
  // Two crawls of one host in the same second get different ids.
  const safeHost = (host.includes(':') ? 'ipv6-' : '') + (host.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site');
  let id = [safeHost, label, stamp].filter(Boolean).join('_');
  for (let n = 2; jobs.has(id) || store.has(id); n++) id = [safeHost, label, stamp, n].filter(Boolean).join('_');
  const o = body.options || {};
  const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(+v) && v !== '' ? +v : d));

  const controller = new AbortController();
  const job = {
    id, label, url, status: 'running', startedAt: new Date().toISOString(),
    progress: { done: 0, queued: 0, current: url },
    counts: { ok: 0, redirect: 0, client: 0, server: 0, failed: 0, blocked: 0 },
    recent: [], clients: new Set(), controller, error: null,
  };
  if (extra.seeds) job.total = extra.seeds.length;
  jobs.set(id, job);

  let pending = [];
  const flush = setInterval(() => {
    if (!pending.length && !job.dirty) return;
    job.dirty = false;
    broadcast(job, 'progress', { progress: job.progress, counts: job.counts, cells: pending });
    pending = [];
  }, 300);

  job.finished = crawl(url, {
    maxUrls: extra.seeds ? extra.seeds.length : num(o.maxUrls, Math.min(5000, URL_LIMIT), 1, URL_LIMIT),
    seeds: extra.seeds || null,
    blockPrivate: PUBLIC_MODE,
    maxDepth: num(o.maxDepth, 50, 0, 100),
    concurrency: num(o.concurrency, 5, 1, 20),
    delayMs: num(o.delayMs, 0, 0, 10000),
    timeoutMs: num(o.timeoutMs, 15000, 1000, 60000),
    auth: o.auth ? String(o.auth) : null,
    ignoreRobots: !!o.ignoreRobots,
    useSitemap: o.useSitemap !== false,
    checks: o.checks === false ? false : { site: o.checks?.site !== false, external: o.checks?.external !== false, images: o.checks?.images !== false },
    onChecks: (c) => {
      job.progress = { ...job.progress, phase: 'checks', step: c.step, checksDone: c.done, checksTotal: c.total, current: c.url || job.progress.current };
      job.dirty = true;
    },
    signal: controller.signal,
    onProgress: (p) => {
      const b = bucket(p);
      job.counts[b]++;
      job.progress = { done: p.done, queued: p.queued, current: p.url };
      job.recent.push(b);
      pending.push(b);
    },
  }).then(async (result) => {
    let audit = null;
    if (!extra.seeds) try { audit = runAudit(result, loadConfig()); } catch (e) { console.error('Denetim hatası:', e.message); }
    const entry = await store.save(id, label, result, audit);
    job.status = result.meta.cancelled ? 'cancelled' : 'done';
    broadcast(job, 'done', { entry, status: job.status });
    return { status: job.status, entry };
  }).catch((e) => {
    job.status = 'error'; job.error = e.message;
    broadcast(job, 'failed', { error: e.message });
    return { status: 'error', error: e.message };
  }).finally(() => {
    clearInterval(flush);
    for (const c of job.clients) c.end();
    setTimeout(() => jobs.delete(id), 60_000);
  });
  return job;
}

// Pages are sent to the browser without link lists to keep the payload small.
function slimPages(pages) {
  return pages.map(({ links, images, textSample, ...p }) => ({
    ...p,
    linkCount: links?.length ?? 0,
    externalLinkCount: links?.filter((l) => !l.internal).length ?? 0,
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    // Health check for the hosting service. No password, no data.
    if (req.url === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
    if (APP_USER && APP_PASS) {
      const expected = 'Basic ' + Buffer.from(`${APP_USER}:${APP_PASS}`).toString('base64');
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="SEO Audit"' });
        return res.end('Giriş gerekli');
      }
    }
    if (!hostAllowed(req)) return send(res, 403, { error: 'Bu adres ile giriş kapalı. Sunucuyu localhost veya IP adresi ile açın. Başka bir ad için ALLOWED_HOSTS ayarını kullanın.' });
    if (!originAllowed(req)) return send(res, 403, { error: 'Başka bir siteden gelen istek kabul edilmez.' });
    const u = new URL(req.url, 'http://local');
    const parts = u.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'api') {
      const name = u.pathname === '/' ? 'index.html' : path.basename(u.pathname);
      const ext = path.extname(name);
      if (!MIME[ext]) return send(res, 404, 'Bulunamadı', 'text/plain');
      try { return send(res, 200, await readFile(path.join(ROOT, 'public', name)), MIME[ext]); }
      catch { return send(res, 404, 'Bulunamadı', 'text/plain'); }
    }

    // /api/compare?old=<id>&new=<id>[,<id>…]&rules=<json>: old site vs one or more new sites.
    // The first new crawl is the main target. /api/compare/excel: same data as Excel.
    if (parts[1] === 'compare' && req.method === 'GET') {
      const cc = loadConfig().compare;
      const a = u.searchParams.get('old');
      const ids = [...new Set((u.searchParams.get('new') || '').split(',').filter(Boolean))];
      if (!a || !ids.length || ![a, ...ids].every((x) => ID_RE.test(x))) return send(res, 400, { error: 'İki tarama seçin: eski ve yeni.' });
      if (ids.includes(a)) return send(res, 400, { error: 'Eski ve yeni tarama farklı olmalı.' });
      if (ids.length > cc.maxTargets) return send(res, 400, { error: `En fazla ${cc.maxTargets} yeni site seçin.` });
      let rules;
      try { rules = parseRules(JSON.parse(u.searchParams.get('rules') || '[]'), cc.maxRules); }
      catch (e) { return send(res, 400, { error: e instanceof SyntaxError ? 'Kurallar okunamadı.' : e.message }); }
      let oldRes, newList;
      try { [oldRes, ...newList] = await Promise.all([a, ...ids].map((x) => store.load(x))); }
      catch { return send(res, 404, { error: 'Tarama bulunamadı. Sunucu yeniden başladıysa taramalar silinmiş olabilir.' }); }
      const cmp = await compareWithProbe(a, ids, oldRes, newList, rules, cc);
      if (parts[2] !== 'excel') return send(res, 200, cmp);
      const tmp = path.join(os.tmpdir(), `cmp-${Date.now()}.xlsx`);
      await exportCompareExcel(cmp, tmp);
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="karsilastirma-${cmp.old.host}-${cmp.new.host}.xlsx"`,
      });
      const buf = await readFile(tmp);
      unlink(tmp).catch(() => {});
      return res.end(buf);
    }


    // /api/projects: migration projects. /api/projects/:id/(crawl|match|excel|export)
    if (parts[1] === 'projects') {
      const pid = parts[2];
      if (!pid) {
        if (req.method === 'GET') {
          const list = await projects.list();
          return send(res, 200, list.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, sites: p.sites.length, rules: p.rules.length,
            crawlIds: [...p.sites.flatMap((s) => [s.crawlId, s.pendingCrawlId, s.liveCrawlId, s.pendingLiveCrawlId]), p.urlList?.crawlId, p.urlList?.pendingCrawlId].filter(Boolean) })));
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          const def = validateProject(body, projectLimits());
          const p = await projects.create(def);
          // v0.12.0: a project file can carry the old address list ("Projeyi indir").
          if (body?.urlList?.sources?.length) {
            const c = loadConfig().urlList || {};
            const L = validateList(body.urlList, { maxSources: c.maxSources, maxRows: c.maxRows });
            if (L.sources.length) await projects.updateList(p.id, () => L);
          }
          return send(res, 201, p);
        }
      }
      if (pid && !PID_RE.test(pid)) return send(res, 400, { error: 'Geçersiz proje' });
      const action = parts[3];
      if (pid && !action) {
        if (req.method === 'GET') { const p = await projects.get(pid); return send(res, 200, { project: p, status: await projectStatus(p), listState: await listState(p) }); }
        if (req.method === 'PUT') {
          const def = validateProject(await readJson(req), projectLimits());
          // The 301 map is not changed here (POST /map changes it). A removed site drops its decisions.
          // v0.11.0: the launch mark and the live crawls are server fields. After launch the crawl ids before launch stay.
          const p = await projects.update(pid, (old) => ({ ...old, ...def, launch: old.launch, urlList: old.urlList, map: cleanMap(old.map || {}, def.sites), sites: def.sites.map((s) => {
            const prev = old.sites.find((x) => x.key === s.key);
            return { ...s, crawlId: old.launch ? prev?.crawlId || null : s.crawlId, pendingCrawlId: prev?.pendingCrawlId || null, lastError: prev?.lastError || null,
              liveCrawlId: prev?.liveCrawlId || null, pendingLiveCrawlId: prev?.pendingLiveCrawlId || null, liveError: prev?.liveError || null };
          }) }));
          return send(res, 200, { project: p, status: await projectStatus(p) });
        }
        if (req.method === 'DELETE') { await projects.remove(pid); return send(res, 200, { ok: true }); }
      }
      if (action === 'crawl' && req.method === 'POST') {
        const body = await readJson(req);
        const job = await startProjectCrawl(pid, String(body.site || ''), body.options || {}, { live: !!body.live });
        return send(res, 201, publicJob(job));
      }
      if ((action === 'match' || action === 'excel') && req.method === 'GET') {
        let m;
        // ?fresh=1 (v0.10.1): ask every old address again, do not use the saved result.
        try { m = await projectMatch(await projects.get(pid), { fresh: action === 'match' && u.searchParams.get('fresh') === '1' }); }
        catch (e) { if (e.code === 409) return send(res, 409, { error: e.message, need: e.need }); throw e; }
        if (action === 'match') {
          const { cmp, sections, targets, status, map, todo, launch } = m;
          return send(res, 200, { ...cmp, sections, targetSites: targets, status, map, todo, launch });
        }
        const tmp = path.join(os.tmpdir(), `prj-${Date.now()}.xlsx`);
        const pe = await projects.get(pid);
        // v0.11.0: after launch the file also has the live check (saved answers, no new requests while they are fresh).
        let verify = null;
        if (pe.launch) { try { verify = await projectVerify(pe); } catch (e) { if (e.code !== 409) throw e; } }
        await exportCompareExcel(m.cmp, tmp, { map: m.map, todo: m.todo, launch: m.launch, verify, urlList: m.urlList, siteNames: { ...siteNames(pe), server: `${m.cmp.old.host} sunucusu` } });
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="tasima-${m.cmp.old.host}.xlsx"`,
        });
        const buf = await readFile(tmp);
        unlink(tmp).catch(() => {});
        return res.end(buf);
      }
      // v0.11.0: POST /launch { at } marks the launch day and locks the crawls before launch. DELETE takes the mark back.
      if (action === 'launch' && req.method === 'POST') {
        const body = await readJson(req);
        const raw = String(body?.at || '');
        const at = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString().slice(0, 10);
        const p0 = await projects.get(pid);
        const st = await projectStatus(p0);
        const need = p0.sites.filter((s) => s.role !== 'extra' && !['done', 'stale'].includes(st[s.key].state));
        if (need.length) return send(res, 409, { error: 'Eski site ve eski alan adına geçecek site taranmadı. Çıkıştan önce iki siteyi tarayın.', need: need.map((s) => s.key) });
        if (p0.sites.some((s) => st[s.key].state === 'running') || (await listState(p0)).state === 'running') return send(res, 409, { error: 'Bir tarama sürüyor. Tarama bitince çıkışı işaretleyin.' });
        const p = await projects.update(pid, (q) => ({ ...q, launch: { at, markedAt: new Date().toISOString(),
          crawls: { ...Object.fromEntries(q.sites.filter((s) => s.crawlId).map((s) => [s.key, s.crawlId])), ...(q.urlList?.crawlId ? { list: q.urlList.crawlId } : {}) } } }));
        verifyCache.delete(pid);
        return send(res, 200, { project: p, status: await projectStatus(p) });
      }
      if (action === 'launch' && req.method === 'DELETE') {
        const p = await projects.update(pid, (q) => { const { launch, ...rest } = q; return rest; });
        verifyCache.delete(pid);
        return send(res, 200, { project: p, status: await projectStatus(p) });
      }
      // v0.11.0: GET /verify[?fresh=1] the live check. 409 with need: ["launch"] before the launch mark.
      if (action === 'verify' && req.method === 'GET') {
        try { return send(res, 200, await projectVerify(await projects.get(pid), { fresh: u.searchParams.get('fresh') === '1' })); }
        catch (e) { if (e.code === 409) return send(res, 409, { error: e.message, need: e.need }); throw e; }
      }
      // 301 map: POST { set: { "/old/path": decision | null } } saves decisions (null removes one).
      // GET ?format=csv gives the final list for the developer (301 and 410 rows).
      if (action === 'map' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.set || typeof body.set !== 'object' || Array.isArray(body.set)) return send(res, 400, { error: 'Karar listesi okunamadı.' });
        const { maxDecisions } = projectLimits();
        const p = await projects.update(pid, (old) => {
          const next = { ...(old.map || {}) };
          for (const [k, v] of Object.entries(body.set)) { if (v === null) delete next[k]; else next[k] = v; }
          return { ...old, map: cleanMap(next, old.sites, maxDecisions) };
        });
        return send(res, 200, { ok: true, decisions: Object.keys(p.map).length, updatedAt: p.updatedAt });
      }
      if (action === 'map' && req.method === 'GET') {
        let m;
        try { m = await projectMatch(await projects.get(pid)); }
        catch (e) { if (e.code === 409) return send(res, 409, { error: e.message, need: e.need }); throw e; }
        if (u.searchParams.get('format') !== 'csv') return send(res, 200, m.map);
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="301-haritasi-${m.cmp.old.host}.csv"` });
        return res.end(mapCsv(m.map));
      }
      // v0.12.0: old address list. GET: sources, counts and rows. POST { text, name?, file?, columns?, preview? }: adds a
      // source (preview: only reads). DELETE /urllist[/<source id>]: removes one source or all. POST /urllist/fetch
      // { ignoreRobots }: asks the addresses that are not in the old crawl on the old site (409 after launch).
      if (action === 'urllist') {
        const sub = parts[4];
        const send409 = (e) => { if (typeof e.code === 'number' && e.code < 500) return send(res, e.code, { error: e.message, ...(e.need ? { need: e.need } : {}), ...(e.columns ? { columns: e.columns } : {}) }); throw e; };
        try {
          if (req.method === 'GET' && !sub) return send(res, 200, await listView(await projects.get(pid)));
          if (req.method === 'POST' && sub === 'fetch') {
            const job = await startListFetch(pid, await readJson(req));
            return send(res, 201, publicJob(job));
          }
          if (req.method === 'POST' && !sub) {
            const out = await addListSource(pid, await readJson(req));
            if (out.preview) return send(res, 200, out);
            return send(res, 201, { ...out, view: await listView(await projects.get(pid)) });
          }
          if (req.method === 'DELETE') {
            if (sub && !/^l[0-9a-z]{1,12}$/.test(sub)) return send(res, 400, { error: 'Geçersiz liste' });
            await projects.updateList(pid, (L) => ({ ...L, sources: sub ? L.sources.filter((x) => x.id !== sub) : [] }));
            return send(res, 200, await listView(await projects.get(pid)));
          }
        } catch (e) { return send409(e); }
      }
      // v0.9.0: POST /ready { site, ok } accepts a thin site as ready (for its current crawl) or takes it back.
      if (action === 'ready' && req.method === 'POST') {
        const body = await readJson(req);
        const key = String(body?.site || '');
        const p = await projects.update(pid, (old) => {
          const s = old.sites.find((x) => x.key === key && x.role !== 'old');
          if (!s?.crawlId) throw Object.assign(new Error('Site taranmadı veya projede yok.'), { code: 400 });
          const readyOk = { ...(old.readyOk || {}) };
          if (body.ok) readyOk[key] = s.crawlId; else delete readyOk[key];
          return { ...old, readyOk };
        });
        return send(res, 200, { ok: true, readyOk: p.readyOk });
      }
      if (action === 'export' && req.method === 'GET') {
        const p = await projects.get(pid);
        const { id, name, structure, sites, rules, createdAt, updatedAt } = p;
        const L = await projects.getList(pid);
        const body = JSON.stringify({ format: 'seo-audit-proje', version: 1, id, name, structure, rules, map: p.map || {}, createdAt, updatedAt,
          ...(p.launch ? { launch: p.launch } : {}),
          // v0.12.0: the old address list (addresses and traffic) and its crawl id. The page content stays on the server.
          ...(L.sources.length || p.urlList?.crawlId ? { urlList: { ...(p.urlList?.crawlId ? { crawlId: p.urlList.crawlId } : {}), sources: L.sources } } : {}),
          sites: sites.map(({ key, role, name: n, url, live, crawlId, liveCrawlId }) => ({ key, role, name: n, url, live, crawlId, ...(liveCrawlId ? { liveCrawlId } : {}) })) }, null, 2);
        const tr = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c' };
        const file = name.toLocaleLowerCase('tr').replace(/[ğüşıöç]/g, (c) => tr[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proje';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="proje-${file}.json"` });
        return res.end(body);
      }
    }

    // /api/info: server mode for the interface
    if (parts[1] === 'info' && req.method === 'GET') {
      return send(res, 200, { publicMode: PUBLIC_MODE, ephemeral: EPHEMERAL, maxUrls: URL_LIMIT, maxJobs: JOB_LIMIT, maxTargets: loadConfig().compare.maxTargets });
    }

    // /api/rules: rule counts per category for the start page
    if (parts[1] === 'rules' && req.method === 'GET') {
      const off = loadConfig().rules || {};
      const active = RULES.filter((r) => off[r.id]?.enabled !== false);
      return send(res, 200, { total: active.length, categories: CATEGORIES.map(([id, name]) => ({ id, name, count: active.filter((r) => r.category === id).length })) });
    }

    // /api/crawls
    if (parts[1] === 'crawls' && parts.length === 2) {
      if (req.method === 'GET') {
        return send(res, 200, { running: [...jobs.values()].filter((j) => j.status === 'running').map(publicJob), history: await store.list() });
      }
      if (req.method === 'POST') {
        const job = await startJob(await readJson(req));
        return send(res, 201, publicJob(job));
      }
    }

    const id = parts[2];
    if (parts[1] === 'crawls' && id) {
      if (!ID_RE.test(id)) return send(res, 400, { error: 'Geçersiz kayıt' });
      const action = parts[3];

      if (action === 'events' && req.method === 'GET') {
        const job = jobs.get(id);
        if (!job) return send(res, 404, { error: 'Aktif tarama yok' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ ...publicJob(job), cells: job.recent })}\n\n`);
        if (job.status !== 'running') return res.end();
        job.clients.add(res);
        req.on('close', () => job.clients.delete(res));
        return;
      }
      if (action === 'cancel' && req.method === 'POST') {
        const job = jobs.get(id);
        if (!job || job.status !== 'running') return send(res, 404, { error: 'Aktif tarama yok' });
        job.controller.abort();
        return send(res, 200, { ok: true });
      }
      if (action === 'excel' && req.method === 'GET') {
        const result = await store.load(id);
        const audit = await getAudit(id, result);
        const tmp = path.join(os.tmpdir(), `${id}-${Date.now()}.xlsx`);
        await exportExcel(result, tmp, audit);
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${id}.xlsx"`,
        });
        const buf = await readFile(tmp);
        unlink(tmp).catch(() => {});
        return res.end(buf);
      }
      if (!action && req.method === 'GET') {
        const result = await store.load(id);
        const audit = await getAudit(id, result);
        const ck = result.checks;
        let checks = null;
        if (ck) {
          const cfg = loadConfig();
          const of = (k) => ck.resources.filter((r) => r.kinds.includes(k));
          checks = {
            ran: ck.ran, site: ck.site, limited: ck.limited, ms: ck.ms,
            links: of('link').length, brokenLinks: of('link').filter((r) => isBroken(r, cfg)).length,
            images: of('image').length, brokenImages: of('image').filter((r) => isBroken(r, cfg)).length,
            largeImages: of('image').filter((r) => r.status && r.status < 400 && r.size > cfg.thresholds.largeImageKb * 1024).length,
          };
        }
        return send(res, 200, { meta: result.meta, summary: Store.summary(result), pages: slimPages(result.pages), audit, checks });
      }
      if (!action && req.method === 'DELETE') {
        await store.remove(id);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    const code = e.code === 'ENOENT' ? 404 : (typeof e.code === 'number' ? e.code : 500);
    send(res, code, { error: code === 404 ? 'Kayıt bulunamadı' : e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SEO Audit çalışıyor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && !APP_USER) console.log('UYARI: Sunucu ağa açık ama şifre yok. APP_USER ve APP_PASS tanımlayın.');
});
