// Tests for the shareable report (v0.14.0) and the .env file. No internet: every site runs on 127.0.0.1 or localhost.
// A: the model and the HTML (no server). B: the API with a hostile site, a migration project and the .env file.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { siteReport, renderReport, teamOf, cleanReportInfo, stagingScore, reportFileName, REPORT_CSP } from '../src/report.js';
import { loadConfig } from '../src/rules/index.js';
import { loadEnv } from '../src/env.js';
import { startMigrationSites } from './fixture-migration.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Rapor testi');
const cfg = loadConfig();
const EVIL = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
// No tag that runs code or loads anything may come from the data. The report itself has none of them.
const noActive = (html) => {
  assert.doesNotMatch(html, /<script/i, 'script etiketi var');
  assert.doesNotMatch(html, /<img/i, 'img etiketi var');
  // Quoted attribute values are text (esc() turns " into &quot;): look at the tags without them.
  assert.doesNotMatch(html.replace(/"[^"]*"/g, '""'), /<[^>]*\son[a-z]+=/i, 'olay özniteliği var');
  assert.doesNotMatch(html, /href="javascript:/i, 'javascript: linki var');
};

// ---------- A. Model and HTML (no requests) ----------
const rule = (id, severity, team, n, extra = {}) => ({ id, category: 'x', severity, team, scope: 'page', title: 'Sorun başlığı', description: 'Sorunun açıklaması', fix: 'Sorunun çözümü',
  count: n, items: Array.from({ length: n }, (_, i) => ({ url: `https://ornek.example/s${i}`, detail: '' })), ...extra });
const audit = (rules, extra = {}) => ({ score: 70, totalUrls: 30, healthyUrls: 21, rules, counts: {}, ...extra });
const meta = { host: 'ornek.example', startedAt: '2026-11-01T10:00:00Z' };

await check('ekip çevirisi: CMS → Backend, Siz → SEO, diğerleri aynı, boş → SEO (rules.json → report.teams)', () => {
  assert.deepEqual(['CMS', 'Siz', 'Frontend', 'İçerik', 'Backend', 'SEO', ''].map((t) => teamOf(t, cfg)), ['Backend', 'SEO', 'Frontend', 'İçerik', 'Backend', 'SEO', 'SEO']);
});
await check('başlık alanları: kontrol karakteri silinir, uzunluk sınırı', () => {
  assert.deepEqual(cleanReportInfo({ client: ' A\u0000B\nC ', by: 'x'.repeat(200) }, cfg), { client: 'A B C', by: 'x'.repeat(cfg.report.maxNameLength) });
  assert.deepEqual(cleanReportInfo({}, cfg), { client: '', by: '' });
});
await check('site raporu: kritik ve uyarı girer, bilgi girmez; ekip gruplaması; özet cümlesi', () => {
  const m = siteReport({ meta, audit: audit([rule('k1', 'critical', 'CMS', 2), rule('u1', 'warning', 'Frontend', 3), rule('b1', 'notice', 'SEO', 4), rule('z0', 'warning', 'SEO', 0)]), cfg });
  assert.deepEqual(m.units.map((u) => u.ruleId), ['k1', 'u1']);
  assert.deepEqual(m.critical.map((u) => u.ruleId), ['k1']);
  assert.deepEqual(m.teams.map((t) => [t.team, t.jobs]), [['Backend', 1], ['Frontend', 1]]);
  assert.match(m.summary, /1 kritik sorun var/);
  assert.ok(m.notes.some((x) => /1 bilgi notu/.test(x)));
});
await check('XSS: taranan siteden gelen metin kaçış ile basılır; CSP meta etiketi var; script yok', () => {
  const r = rule('k1', 'critical', 'SEO', 1);
  r.items = [{ url: `https://ornek.example/${EVIL}`, detail: EVIL }, { url: `javascript:alert(3)`, detail: '' }];
  const html = renderReport(siteReport({ meta: { ...meta, host: EVIL }, audit: audit([r]), cfg, audience: 'ekip', info: { client: EVIL, by: EVIL } }));
  noActive(html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP.replace(/'/g, '&#39;')}">`));
  assert.match(REPORT_CSP, /default-src 'none'/);
});
await check('kitle: müşteri raporunda kural kimliği yok, ekip raporunda var; liste sınırı rules.json\'dan', () => {
  const a = audit([rule('baslik-kimligi', 'warning', 'SEO', 60)]);
  const mus = renderReport(siteReport({ meta, audit: a, cfg, audience: 'musteri' }));
  const ekip = renderReport(siteReport({ meta, audit: a, cfg, audience: 'ekip' }));
  assert.doesNotMatch(mus, /baslik-kimligi/);
  assert.match(ekip, /<code>baslik-kimligi<\/code>/);
  const rows = (h) => (h.match(/ornek\.example\/s\d+<\/a>/g) || []).length;
  assert.equal(rows(mus), cfg.report.listLimit.musteri);
  assert.equal(rows(ekip), cfg.report.listLimit.ekip);
  assert.match(mus, /İlk 20 satır görünüyor \(60 satır var\)/);
  // Unknown audience: the client report (the safe one).
  assert.equal(siteReport({ meta, audit: a, cfg, audience: 'x' }).audience, 'musteri');
});
await check('boş sütun gizlenir: ayrıntısı olmayan listede "Ayrıntı" sütunu yok', () => {
  const html = renderReport(siteReport({ meta, audit: audit([rule('u1', 'warning', 'SEO', 2)]), cfg }));
  assert.match(html, /<th scope="col">Adres<\/th><\/tr>/);
  assert.doesNotMatch(html, />Ayrıntı</);
});
await check('staging skoru: robots.txt Disallow skoru 40 ile sınırlamaz; başka site kuralı sınırlar', () => {
  const site = (id) => ({ ...rule(id, 'critical', 'SEO', 1), scope: 'site' });
  const a = audit([site('robots-blocks-site')], { score: 40, totalUrls: 10, healthyUrls: 9 });
  assert.deepEqual(stagingScore(a, cfg), { score: 90, adjusted: true, left: ['Sorun başlığı'] });
  assert.equal(stagingScore(audit([site('robots-blocks-site'), site('ssl-invalid')], { score: 40, totalUrls: 10, healthyUrls: 9 }), cfg).score, 40);
  assert.deepEqual(stagingScore(audit([], { score: 77 }), cfg), { score: 77, adjusted: false });
});
await check('dosya adı: Türkçe harf sadeleşir, sadece harf, rakam ve tire', () => {
  assert.equal(reportFileName('Şahin Güzellik / İstanbul', new Date('2026-11-14T08:00:00Z')), 'rapor-sahin-guzellik-istanbul-2026-11-14.html');
  assert.equal(reportFileName('"><x>', new Date('2026-11-14T08:00:00Z')), 'rapor-x-2026-11-14.html');
});
await check('.env: dosya değeri okunur, kabuktaki değer (boş da) kalır, dosya yoksa hata yok', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'seo-env-'));
  const f = path.join(d, '.env');
  await writeFile(f, 'SEO_T_A=dosya\nSEO_T_B=dosya\nSEO_T_C=dosya\n');
  process.env.SEO_T_B = 'kabuk'; process.env.SEO_T_C = '';
  assert.deepEqual(loadEnv(f), { loaded: true });
  assert.deepEqual([process.env.SEO_T_A, process.env.SEO_T_B, process.env.SEO_T_C], ['dosya', 'kabuk', '']);
  assert.deepEqual(loadEnv(path.join(d, 'yok.env')), { loaded: false, reason: 'none' });
  delete process.env.SEO_T_A; delete process.env.SEO_T_B; delete process.env.SEO_T_C;
  await rm(d, { recursive: true, force: true });
});

// ---------- B. API ----------
const listen = (handler, host = '127.0.0.1') => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, host, () => ok(s)); });
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const page = (title, body = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>x</h1>${body}</body></html>`;
// Hostile site: the same hostile title on two pages (the duplicate title rule writes it in its detail).
const evil = await listen((q, res) => {
  const u = new URL(q.url, 'http://x').pathname;
  if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(''); }
  if (!['/', '/a', '/b'].includes(u)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(page('404')); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(u === '/' ? 'Ana' : EVIL, '<a href="/a">a</a> <a href="/b">b</a>'));
});
const EVIL_URL = `http://127.0.0.1:${evil.address().port}/`;
const [oldSite, heirSite] = await startMigrationSites();
const OLD = `http://127.0.0.1:${oldSite.address().port}/`, HEIR = `http://localhost:${heirSite.address().port}`;

const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-rep-'));
const envDir = await mkdtemp(path.join(os.tmpdir(), 'seo-repenv-'));
const envFile = path.join(envDir, '.env');
await writeFile(envFile, 'ALLOWED_HOSTS=env.ornek.example\n');
const servers = [];
async function startServer(env) {
  const port = await freePort();
  const base = { ...process.env };
  delete base.ALLOWED_HOSTS;
  const p = spawn(process.execPath, ['src/server.js'], { env: { ...base, PUBLIC_MODE: '', APP_USER: '', APP_PASS: '', HOST: '127.0.0.1', PORT: String(port), CRAWL_DIR: dir, ENV_FILE: envFile, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(url + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return url;
}
const base = await startServer({});
const api = async (p, o = {}) => {
  const r = await fetch(base + p, { headers: { 'content-type': 'application/json' }, ...o, body: o.body && JSON.stringify(o.body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, data };
};
const wait = async (f, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('zaman aşımı'); };
const hostGet = (url, host) => new Promise((ok, no) => { const u = new URL(url); http.get({ hostname: u.hostname, port: u.port, path: '/api/info', headers: { host } }, (r) => { r.resume(); ok(r.statusCode); }).on('error', no); });

await check('.env: sunucu ENV_FILE dosyasını okur (ALLOWED_HOSTS), kabuktaki boş değer dosyayı ezer', async () => {
  assert.equal(await hostGet(base, 'env.ornek.example'), 200);
  assert.equal(await hostGet(base, 'baska.ornek.example'), 403);
  const shell = await startServer({ ALLOWED_HOSTS: '' });
  assert.equal(await hostGet(shell, 'env.ornek.example'), 403);
});
await check('site raporu (API): indirme, CSP başlığı, dosya adı, kötü niyetli title kaçışlı, script yok', async () => {
  const j = await api('/api/crawls', { method: 'POST', body: { url: EVIL_URL, options: { checks: false } } });
  assert.equal(j.status, 201);
  await wait(async () => !(await api('/api/crawls')).data.running.length);
  const r = await api(`/api/crawls/${j.data.id}/report?kitle=ekip&musteri=${encodeURIComponent(EVIL)}&hazirlayan=Cihan`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.equal(r.headers.get('content-security-policy'), REPORT_CSP);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="rapor-127-0-0-1-\d{4}-\d{2}-\d{2}\.html"$/);
  noActive(r.text);
  assert.ok(r.text.includes('&quot;&lt;script&gt;alert(1)&lt;/script&gt;'), 'title ayrıntıda kaçışlı');
  assert.match(r.text, /Hazırlayan: Cihan/);
  assert.equal((await api('/api/crawls/yok_1/report')).status, 404);
});

let pid;
await check('proje raporu: taranmadan 409; adlar projeye kaydedilir ve "Projeyi indir" taşır', async () => {
  const c = await api('/api/projects', { method: 'POST', body: { name: EVIL, structure: 'same', rules: [], report: { client: 'Kavrulmuş Kahve', by: 'Cihan' },
    sites: [{ role: 'old', url: OLD }, { role: 'heir', url: HEIR }] } });
  assert.equal(c.status, 201);
  pid = c.data.id;
  assert.deepEqual(c.data.report, { client: 'Kavrulmuş Kahve', by: 'Cihan' });
  const r = await api(`/api/projects/${pid}/report`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /taranmadı/);
  const ex = JSON.parse((await api(`/api/projects/${pid}/export`)).text);
  assert.deepEqual(ex.report, { client: 'Kavrulmuş Kahve', by: 'Cihan' });
  // PUT with the field replaces it, PUT without it keeps it (an old browser tab).
  const p = c.data;
  const put = (body) => api(`/api/projects/${pid}`, { method: 'PUT', body });
  assert.deepEqual((await put({ ...p, report: { client: 'Yeni', by: '' } })).data.project.report, { client: 'Yeni', by: '' });
  const { report, ...noReport } = p;
  assert.deepEqual((await put(noReport)).data.project.report, { client: 'Yeni', by: '' });
  await put({ ...p, report: { client: 'Kavrulmuş Kahve', by: 'Cihan' } });
});
await check('proje raporu: çıkış öncesi; özet, adımlar, ekip çevirisi; proje adı kaçışlı', async () => {
  for (const key of ['old', 'heir']) {
    await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } });
    await wait(async () => { const d = (await api(`/api/projects/${pid}`)).data; return d.status[key].state === 'done' && !d.project.sites.find((s) => s.key === key).pendingCrawlId; });
  }
  const r = await api(`/api/projects/${pid}/report?kitle=musteri`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), REPORT_CSP);
  noActive(r.text);
  assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(r.text, /<p class="client">Kavrulmuş Kahve<\/p>/);
  assert.match(r.text, /Canlıya çıkış öncesi/);
  assert.match(r.text, /Eski sitenin 9 sayfasından 2 tanesi yeni sitede yerinde \(%22\)\./);
  assert.match(r.text, /<b>Canlı doğrulama<\/b> · Çıkıştan sonra/);
  // The decisions of the 301 map are the owner's work: "Siz" → SEO. No "Siz" or "CMS" in the report.
  assert.match(r.text, /<h3>SEO · \d+ iş<\/h3>/);
  assert.doesNotMatch(r.text, /\bSiz\b|\bCMS\b/);
  // Query values win over the project values (one download, the project does not change).
  const q = await api(`/api/projects/${pid}/report?musteri=Ba%C5%9Fka`);
  assert.match(q.text, /<p class="client">Başka<\/p>/);
  assert.equal((await api(`/api/projects/${pid}`)).data.project.report.client, 'Kavrulmuş Kahve');
});
await check('proje raporu: çıkıştan sonra canlı doğrulama sonucu ve "Yapılacaklar" çıkış öncesi liste olur', async () => {
  assert.equal((await api(`/api/projects/${pid}/launch`, { method: 'POST', body: { at: '2026-11-10' } })).status, 200);
  const r = await api(`/api/projects/${pid}/report?kitle=ekip`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Canlıya çıktı · 10\.11\.2026/);
  assert.match(r.text, /eski adres canlıda kontrol edildi/);
  assert.match(r.text, /<b>Yapılacaklar<\/b> · Çıkıştan önceki liste/);
  noActive(r.text);
});

for (const p of servers) p.kill();
evil.close(); oldSite.close(); heirSite.close();
await rm(dir, { recursive: true, force: true });
await rm(envDir, { recursive: true, force: true });
console.log(`${passed} kontrol geçti, ${failed} başarısız.`);
process.exit(failed ? 1 : 0);
