// Web interface: start crawls, watch progress live, browse results, download Excel.
import http from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from './crawler.js';
import { exportExcel } from './export.js';
import { Store, ID_RE } from './store.js';
import { normalizeUrl } from './normalize.js';
import { runAudit, loadConfig, RULES, CATEGORIES } from './rules/index.js';
import { isBroken } from './rules/helpers.js';
import os from 'node:os';
import { makeGuard } from './netguard.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +(process.env.PORT || 3300);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JOBS = +(process.env.MAX_JOBS || 2);
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;

// PUBLIC_MODE=1: the server is open to the internet (Render). Password is required,
// private addresses are blocked and limits from config/rules.json → yayin apply.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const EPHEMERAL = process.env.EPHEMERAL_STORAGE === '1';
const YAYIN = loadConfig().yayin;
if (PUBLIC_MODE && (!APP_USER || !APP_PASS || APP_PASS.length < YAYIN.minPassLength)) {
  console.error(`HATA: PUBLIC_MODE=1 iken APP_USER ve en az ${YAYIN.minPassLength} karakterli APP_PASS gerekli. Sunucu başlamadı.`);
  process.exit(1);
}
const JOB_LIMIT = PUBLIC_MODE ? YAYIN.maxJobs : MAX_JOBS;
const URL_LIMIT = PUBLIC_MODE ? YAYIN.maxUrls : 50000;
const startGuard = PUBLIC_MODE ? makeGuard() : null;

const store = new Store(process.env.CRAWL_DIR || path.join(ROOT, 'crawls'));
await store.init();

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

  crawl(url, {
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
  }).catch((e) => {
    job.status = 'error'; job.error = e.message;
    broadcast(job, 'failed', { error: e.message });
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

    // /api/info: server mode for the interface
    if (parts[1] === 'info' && req.method === 'GET') {
      return send(res, 200, { publicMode: PUBLIC_MODE, ephemeral: EPHEMERAL, maxUrls: URL_LIMIT, maxJobs: JOB_LIMIT });
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
