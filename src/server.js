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
import { buildLaunch } from './launch.js';
import os from 'node:os';
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

// Comparison results are cached per crawl pair: probing old paths on the new host takes time.
const cmpCache = new Map();
// The cache key holds the crawl ids and the rules, so a new rule set runs a new comparison.
// live: { crawl host → live host } of the target sites (project only).
async function compareWithProbe(a, ids, oldRes, newList, rules, cc, live = {}) {
  const key = `${a}|${ids.join(',')}|${JSON.stringify(rules.map((r) => r.text))}|${JSON.stringify(live)}`;
  if (cmpCache.has(key)) return cmpCache.get(key);
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
  cmpCache.set(key, cmp);
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

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new Error('İstek çok büyük'); }
  return raw ? JSON.parse(raw) : {};
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
async function projectStatus(p) {
  const out = {};
  for (const site of p.sites) {
    const job = site.pendingCrawlId && jobs.get(site.pendingCrawlId);
    if (job && job.status === 'running') { out[site.key] = { state: 'running', jobId: job.id, done: job.progress.done, phase: job.progress.phase || 'crawl' }; continue; }
    if (!site.crawlId) { out[site.key] = { state: 'none', error: site.lastError || null }; continue; }
    const m = await store.meta(site.crawlId);
    if (!m) { out[site.key] = { state: 'deleted', crawlId: site.crawlId }; continue; }
    const urlHost = site.url ? bareHost(new URL(site.url).hostname) : '';
    out[site.key] = {
      state: urlHost && bareHost(m.host) !== urlHost ? 'stale' : 'done',
      crawlId: m.id, host: m.host, startedAt: m.startedAt, pages: m.summary.total, ok: m.summary.ok,
      blocked: m.summary.blocked, limitReached: !!m.limitReached, cancelled: !!m.cancelled, error: site.lastError || null,
    };
  }
  return out;
}

// Starts a crawl for one site of a project. The crawl id is written to the project when the crawl ends.
async function startProjectCrawl(id, key, options) {
  const p = await projects.get(id);
  const site = p.sites.find((s) => s.key === key);
  if (!site) throw Object.assign(new Error('Site projede yok.'), { code: 404 });
  if (!site.url) throw Object.assign(new Error('Önce sitenin adresini yazın.'), { code: 400 });
  const job = await startJob({ url: site.url, label: site.role === 'old' ? 'eski' : 'yeni', options });
  await projects.update(id, (q) => { const s = q.sites.find((x) => x.key === key); if (s) { s.pendingCrawlId = job.id; s.lastError = null; } });
  job.finished.then((r) => projects.update(id, (q) => {
    const s = q.sites.find((x) => x.key === key);
    if (!s || s.pendingCrawlId !== job.id) return;
    s.pendingCrawlId = null;
    if (r.status === 'error') s.lastError = r.error; else { s.crawlId = job.id; s.lastError = null; }
  })).catch((e) => console.error('Proje güncellenemedi:', e.message));
  return job;
}

// Display names of the project sites (Excel). The heir and the old site have fixed names.
function siteNames(p) {
  const out = { old: 'Eski site' };
  for (const s of p.sites) if (s.role !== 'old') out[s.key] = s.role === 'heir' ? 'Eski alan adına geçecek site' : s.name || 'Ek site';
  return out;
}

// Matching of a project: old site → heir and other sites. Sections without a decision get the suggested move.
async function projectMatch(p) {
  const cc = loadConfig().compare;
  const status = await projectStatus(p);
  const old = p.sites.find((s) => s.role === 'old'), heir = p.sites.find((s) => s.role === 'heir');
  const missing = [old, heir].filter((s) => status[s.key].state !== 'done' && status[s.key].state !== 'stale');
  if (missing.length) {
    const names = missing.map((s) => (s.role === 'old' ? 'Eski site' : 'Eski alan adına geçecek site'));
    throw Object.assign(new Error(`${names.join(' ve ')} taranmadı. Eşleştirme için gerekli.`), { code: 409, need: missing.map((s) => s.key) });
  }
  const targets = [heir, ...p.sites.filter((s) => s.role === 'extra' && ['done', 'stale'].includes(status[s.key].state))];
  const ids = targets.map((s) => status[s.key].crawlId);
  const [oldRes, ...newList] = await Promise.all([status[old.key].crawlId, ...ids].map((x) => store.load(x)));
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
  const cmp = await compareWithProbe(status[old.key].crawlId, ids, oldRes, newList, rules, cc, live);
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
  // 301 map (v0.8.0): heir first. The heir takes the old domain, so its live origin is the old origin.
  const oldOrigin = new URL(oldRes.meta.startUrl);
  const mapSites = targets.map((s, i) => {
    const res = newList[i];
    return { key: s.key, host: res.meta.host, origin: new URL(res.meta.startUrl).origin, pages: res.pages,
      liveOrigin: s.role === 'heir' ? oldOrigin.origin : s.live ? `${oldOrigin.protocol}//${s.live}` : null };
  });
  const map = buildRedirectMap(cmp, oldRes, mapSites, p.map || {}, loadConfig().redirectMap);
  map.noLive = mapSites.filter((s) => !s.liveOrigin).map((s) => s.key);
  // Work list by place (v0.9.0). A thin site (few pages) is "not ready" until the user accepts its crawl.
  const todo = buildTodo({ cmp, map, sections, oldHost: oldRes.meta.host, readyOk: p.readyOk || {}, cfg: loadConfig().todo || {},
    sites: targets.map((s, i) => ({ key: s.key, role: s.role, name: s.name, host: newList[i].meta.host, origin: mapSites[i].origin, liveOrigin: mapSites[i].liveOrigin,
      okPages: newList[i].pages.filter(isOk).length, crawlId: status[s.key].crawlId })) });
  // Launch list (v0.10.0): staging checks of every target site, the 301 list and the tags of the old site.
  const launch = buildLaunch({ oldRes, map, cfg: loadConfig(),
    sites: targets.map((s, i) => ({ key: s.key, role: s.role, res: newList[i], liveOrigin: mapSites[i].liveOrigin })) });
  return { cmp, sections, targets: targets.map((s) => s.key), status, map, todo, launch };
}

async function startJob(body) {
  const url = normalizeUrl(String(body.url || '').trim());
  if (!url) throw Object.assign(new Error('Geçerli bir adres yazın. Örnek: https://www.ornek.com'), { code: 400 });
  if (startGuard && await startGuard(url)) throw Object.assign(new Error('Bu adres bir iç ağ adresi. Yayındaki sunucu iç ağ adreslerini taramaz.'), { code: 400 });
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  if (running >= JOB_LIMIT) throw Object.assign(new Error(`Aynı anda en fazla ${JOB_LIMIT} tarama çalışır. Bir taramanın bitmesini bekleyin.`), { code: 429 });

  const label = String(body.label || '').replace(/[^\w-]/g, '').slice(0, 20);
  const host = new URL(url).hostname;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = [host, label, stamp].filter(Boolean).join('_');
  const o = body.options || {};
  const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(+v) && v !== '' ? +v : d));

  const controller = new AbortController();
  const job = {
    id, label, url, status: 'running', startedAt: new Date().toISOString(),
    progress: { done: 0, queued: 0, current: url },
    counts: { ok: 0, redirect: 0, client: 0, server: 0, failed: 0, blocked: 0 },
    recent: [], clients: new Set(), controller, error: null,
  };
  jobs.set(id, job);

  let pending = [];
  const flush = setInterval(() => {
    if (!pending.length && !job.dirty) return;
    job.dirty = false;
    broadcast(job, 'progress', { progress: job.progress, counts: job.counts, cells: pending });
    pending = [];
  }, 300);

  job.finished = crawl(url, {
    maxUrls: num(o.maxUrls, Math.min(5000, URL_LIMIT), 1, URL_LIMIT),
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
    try { audit = runAudit(result, loadConfig()); } catch (e) { console.error('Denetim hatası:', e.message); }
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
            crawlIds: p.sites.flatMap((s) => [s.crawlId, s.pendingCrawlId]).filter(Boolean) })));
        }
        if (req.method === 'POST') {
          const def = validateProject(await readJson(req), projectLimits());
          return send(res, 201, await projects.create(def));
        }
      }
      if (pid && !PID_RE.test(pid)) return send(res, 400, { error: 'Geçersiz proje' });
      const action = parts[3];
      if (pid && !action) {
        if (req.method === 'GET') { const p = await projects.get(pid); return send(res, 200, { project: p, status: await projectStatus(p) }); }
        if (req.method === 'PUT') {
          const def = validateProject(await readJson(req), projectLimits());
          // The 301 map is not changed here (POST /map changes it). A removed site drops its decisions.
          const p = await projects.update(pid, (old) => ({ ...old, ...def, map: cleanMap(old.map || {}, def.sites), sites: def.sites.map((s) => {
            const prev = old.sites.find((x) => x.key === s.key);
            return { ...s, pendingCrawlId: prev?.pendingCrawlId || null, lastError: prev?.lastError || null };
          }) }));
          return send(res, 200, { project: p, status: await projectStatus(p) });
        }
        if (req.method === 'DELETE') { await projects.remove(pid); return send(res, 200, { ok: true }); }
      }
      if (action === 'crawl' && req.method === 'POST') {
        const body = await readJson(req);
        const job = await startProjectCrawl(pid, String(body.site || ''), body.options || {});
        return send(res, 201, publicJob(job));
      }
      if ((action === 'match' || action === 'excel') && req.method === 'GET') {
        let m;
        try { m = await projectMatch(await projects.get(pid)); }
        catch (e) { if (e.code === 409) return send(res, 409, { error: e.message, need: e.need }); throw e; }
        if (action === 'match') {
          const { cmp, sections, targets, status, map, todo, launch } = m;
          return send(res, 200, { ...cmp, sections, targetSites: targets, status, map, todo, launch });
        }
        const tmp = path.join(os.tmpdir(), `prj-${Date.now()}.xlsx`);
        await exportCompareExcel(m.cmp, tmp, { map: m.map, todo: m.todo, launch: m.launch, siteNames: siteNames(await projects.get(pid)) });
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="tasima-${m.cmp.old.host}.xlsx"`,
        });
        const buf = await readFile(tmp);
        unlink(tmp).catch(() => {});
        return res.end(buf);
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
        const body = JSON.stringify({ format: 'seo-audit-proje', version: 1, id, name, structure, rules, map: p.map || {}, createdAt, updatedAt,
          sites: sites.map(({ key, role, name: n, url, live, crawlId }) => ({ key, role, name: n, url, live, crawlId })) }, null, 2);
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
