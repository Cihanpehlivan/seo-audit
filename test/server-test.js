// Tests for the local server (v0.10.1): Host and Origin checks, request size, fresh 301 check, crawl ids.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Sunucu testi');

const listen = (handler, host = '127.0.0.1') => new Promise((done, fail) => { const s = http.createServer(handler); s.on('error', fail); s.listen(0, host, () => done(s)); });
const html = (title, body = '') => `<!doctype html><html lang="tr"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const site = (routes) => listen((q, res) => {
  const r = routes(q.url);
  if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(html('404')); }
  if (r.loc) { res.writeHead(301, { location: r.loc }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(r);
});

// Old site: two service pages. New site: one new page. The 301 for /hizmet-a is set up later (redirectOn).
// v0.11.0: after launch (switched) the old domain serves the new site with the 301 for /hizmet-a.
let redirectOn = false, switched = false;
const newRoutes = (u) => (u === '/' ? html('Yeni', '<a href="/yeni-a">a</a>') : u === '/yeni-a' ? html('Yeni A') : u === '/hizmet-a' ? { loc: '/yeni-a' } : null);
const oldSrv = await site((u) => (switched ? newRoutes(u) : u === '/' ? html('Eski', '<a href="/hizmet-a">a</a><a href="/hizmet-b">b</a>') : /^\/hizmet-[ab]$/.test(u) ? html('Hizmet ' + u) : null));
const newSrv = await site((u) => (u === '/' ? html('Yeni', '<a href="/yeni-a">a</a>') : u === '/yeni-a' ? html('Yeni A') : redirectOn && u === '/hizmet-a' ? { loc: '/yeni-a' } : null));
const OLD = `http://127.0.0.1:${oldSrv.address().port}/`;
const NEW = `http://localhost:${newSrv.address().port}/`;

const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-srv-'));
const port = await freePort();
const srv = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PUBLIC_MODE: '', APP_USER: '', APP_PASS: '', HOST: '127.0.0.1', PORT: String(port), CRAWL_DIR: dir, ALLOWED_HOSTS: 'seo.ofis.example' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const api = async (p, opt = {}) => {
  const r = await fetch(base + p, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
// fetch does not let a script set the Host header: a raw request does.
const raw = (pathname, headers) => new Promise((done, fail) => {
  const q = http.request({ host: '127.0.0.1', port, path: pathname, headers }, (r) => { r.resume(); done(r.statusCode); });
  q.on('error', fail); q.end();
});

await check('Host: yabancı ad reddedilir, localhost, IP ve ALLOWED_HOSTS kabul edilir', async () => {
  assert.equal(await raw('/api/crawls', { host: 'saldirgan.example' }), 403);
  assert.equal(await raw('/', { host: `saldirgan.example:${port}` }), 403);
  assert.equal(await raw('/api/crawls', { host: `localhost:${port}` }), 200);
  assert.equal(await raw('/api/crawls', { host: `127.0.0.1:${port}` }), 200);
  assert.equal(await raw('/api/crawls', { host: 'seo.ofis.example' }), 200);
  assert.equal(await raw('/healthz', { host: 'saldirgan.example' }), 200);
});

const DEF = { name: 'Sunucu testi', sites: [{ role: 'old', url: OLD }, { role: 'heir', url: NEW }] };
await check('Origin: başka siteden gelen yazma isteği reddedilir', async () => {
  const bad = await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://saldirgan.example' }, body: JSON.stringify(DEF) });
  assert.equal(bad.status, 403);
  assert.equal((await api('/api/projects')).data.length, 0, 'proje oluşmamalı');
  assert.equal((await api('/api/projects', { method: 'POST', body: DEF, headers: { origin: 'null' } })).status, 403);
  // A read from another origin is not blocked here: the browser does not give the answer to the other page (no CORS header).
  assert.equal((await api('/api/projects', { headers: { origin: 'http://saldirgan.example' } })).status, 200);
});

let pid;
await check('Origin: sunucunun kendi sayfası yazar', async () => {
  const r = await api('/api/projects', { method: 'POST', body: DEF, headers: { origin: base } });
  assert.equal(r.status, 201);
  pid = r.data.id;
});

await check('istek boyutu: büyük proje dosyası yüklenir, sınırın üstü 413, bozuk JSON 400', async () => {
  const map = {};
  for (let i = 0; i < 3000; i++) map[`/eski/hizmetler/sayfa-adi-${i}`] = { site: 'heir', path: `/yeni/hizmetler/sayfa-adi-${i}`, src: 'oneri' };
  assert.ok(JSON.stringify(map).length > 250_000);
  const up = await api('/api/projects', { method: 'POST', body: { ...DEF, name: 'Büyük', map } });
  assert.equal(up.status, 201);
  assert.equal(Object.keys(up.data.map).length, 3000);
  assert.equal((await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: map } })).data.decisions, 3000);
  assert.equal((await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: Object.fromEntries(Object.keys(map).map((k) => [k, null])) } })).data.decisions, 0);
  const huge = await api('/api/projects', { method: 'POST', body: { ...DEF, pad: 'x'.repeat(5 * 1024 * 1024) } });
  assert.equal(huge.status, 413);
  assert.match(huge.data.error, /çok büyük/);
  const broken = await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":' });
  assert.equal(broken.status, 400);
});

const waitCrawls = async () => {
  for (let i = 0; i < 100; i++) {
    const { data } = await api(`/api/projects/${pid}`);
    if (Object.values(data.status).every((x) => x.state !== 'running' && x.live?.state !== 'running')) return data.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('tarama bitmedi');
};
const kindOf = (m, p) => m.data.sections.flatMap((x) => x.pageList).find((g) => g.path === p)?.kind;

await check('301 kontrolü: kayıtlı sonuç kullanılır, "Tekrar kontrol et" adresleri tekrar ister', async () => {
  for (const key of ['old', 'heir']) {
    assert.equal((await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } })).status, 201);
    await waitCrawls();
  }
  const first = await api(`/api/projects/${pid}/match`);
  assert.equal(first.status, 200);
  assert.equal(first.data.summary.redirected, 0);
  assert.ok(first.data.checkedAt, 'kontrol zamanı yanıtta olmalı');
  redirectOn = true; // the developer sets up the 301 on the new site
  const cached = await api(`/api/projects/${pid}/match`);
  assert.equal(cached.data.summary.redirected, 0, 'kayıtlı sonuç gelmeli');
  assert.equal(cached.data.checkedAt, first.data.checkedAt);
  const fresh = await api(`/api/projects/${pid}/match?fresh=1`);
  assert.equal(fresh.data.summary.redirected, 1, 'yeni 301 görünmeli');
  assert.equal(kindOf(fresh, '/hizmet-a'), 'redirected');
  assert.ok(fresh.data.checkedAt > first.data.checkedAt);
  const after = await api(`/api/projects/${pid}/match`);
  assert.equal(after.data.summary.redirected, 1, 'yeni sonuç kayıtta kalmalı');
});

await check('canlı doğrulama: çıkıştan önce yok, çıkış taramaları kilitler, canlı tarama ayrı kimlik alır', async () => {
  const before = await api(`/api/projects/${pid}/verify`);
  assert.equal(before.status, 409);
  assert.deepEqual(before.data.need, ['launch']);
  assert.equal((await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: 'heir', live: true } })).status, 409);
  const l = await api(`/api/projects/${pid}/launch`, { method: 'POST', body: { at: '2026-11-20' } });
  assert.equal(l.status, 200);
  assert.equal(l.data.project.launch.at, '2026-11-20');
  const staging = l.data.project.sites.find((s) => s.key === 'heir').crawlId;
  assert.equal(l.data.project.launch.crawls.heir, staging);
  for (const key of ['old', 'heir']) {
    const r = await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } });
    assert.equal(r.status, 409, key);
    assert.match(r.data.error, /kilitli/);
  }
  assert.equal((await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: 'old', live: true } })).status, 400);
  // A PUT from an old browser copy cannot change a locked crawl id or remove the launch mark.
  const put = await api(`/api/projects/${pid}`, { method: 'PUT', body: { ...l.data.project, launch: undefined, sites: l.data.project.sites.map((s) => ({ ...s, crawlId: s.key === 'old' ? null : s.crawlId })) } });
  assert.equal(put.data.project.launch.at, '2026-11-20');
  assert.ok(put.data.project.sites.find((s) => s.key === 'old').crawlId);
  switched = true; // DNS switch: the old domain serves the new site
  assert.equal((await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: 'heir', live: true, options: { checks: false } } })).status, 201);
  const st = await waitCrawls();
  assert.equal(st.heir.live.state, 'done');
  assert.notEqual(st.heir.live.crawlId, staging);
  assert.equal(st.heir.crawlId, staging, 'staging taraması değişmemeli');
  assert.equal(new URL(st.heir.live.origin).origin, new URL(OLD).origin, 'canlı tarama eski alan adında');
});
const vKinds = (v) => Object.fromEntries(v.data.groups.flatMap((g) => g.items).filter((i) => i.listKind === 'redirect').flatMap((i) => i.list.map((x) => [new URL(x.old).pathname, i.kind])));
await check('canlı doğrulama: sonuç istekten gelir, kayıtlı kalır, karar değişince tekrar istenir, Excel sayfası', async () => {
  const v = await api(`/api/projects/${pid}/verify`);
  assert.equal(v.status, 200);
  assert.deepEqual(vKinds(v), { '/': 'ok-200', '/hizmet-a': 'ok-open', '/hizmet-b': 'lost' });
  assert.equal(v.data.counts.critical, 1);
  assert.equal(v.data.sites.find((s) => s.key === 'heir').state, 'done');
  assert.equal((await api(`/api/projects/${pid}/verify`)).data.checkedAt, v.data.checkedAt, 'kayıtlı sonuç gelmeli');
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/hizmet-b': { gone: true, src: 'elle' } } } });
  const d = await api(`/api/projects/${pid}/verify`);
  assert.equal(vKinds(d)['/hizmet-b'], 'no410', 'yeni karar hemen kontrol edilmeli');
  const fresh = await api(`/api/projects/${pid}/verify?fresh=1`);
  assert.ok(fresh.data.checkedAt >= d.data.checkedAt);
  const x = await fetch(`${base}/api/projects/${pid}/excel`);
  assert.equal(x.status, 200);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  const ws = wb.getWorksheet('Canlı doğrulama');
  assert.ok(ws, 'Canlı doğrulama sayfası yok');
  assert.ok(ws.getSheetValues().some((r) => Array.isArray(r) && r.includes('410 bekleniyordu, gelmedi')));
  const del = await api(`/api/projects/${pid}/launch`, { method: 'DELETE' });
  assert.equal(del.data.project.launch, undefined);
  assert.equal((await api(`/api/projects/${pid}/verify`)).status, 409);
});

await check('tarama kimliği: aynı saniyede iki tarama ayrı kimlik alır', async () => {
  const [a, b] = await Promise.all([1, 2].map(() => api('/api/crawls', { method: 'POST', body: { url: OLD, options: { checks: false, maxUrls: 1 } } })));
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.notEqual(a.data.id, b.data.id);
  for (let i = 0; i < 100; i++) { const { data } = await api('/api/crawls'); if (!data.running.length) break; await new Promise((r) => setTimeout(r, 100)); }
});

// IPv6 loopback is not on every machine. Without it this check is skipped.
let v6 = null;
try { v6 = await listen((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('IPv6')); }, '::1'); } catch {}
if (v6) {
  await check('tarama kimliği: IPv6 adresli tarama kaydedilir', async () => {
    const r = await api('/api/crawls', { method: 'POST', body: { url: `http://[::1]:${v6.address().port}/`, options: { checks: false, maxUrls: 1, useSitemap: false } } });
    assert.equal(r.status, 201);
    assert.match(r.data.id, /^[\w.-]+$/);
    let entry = null;
    for (let i = 0; i < 100 && !entry; i++) { entry = (await api('/api/crawls')).data.history.find((e) => e.id === r.data.id); if (!entry) await new Promise((x) => setTimeout(x, 100)); }
    assert.ok(entry, 'tarama geçmişte yok');
    assert.equal((await api(`/api/crawls/${r.data.id}`)).status, 200);
  });
  v6.close();
} else console.log('  - IPv6 yok: IPv6 kimlik kontrolü atlandı');

srv.kill();
oldSrv.close(); newSrv.close();
await rm(dir, { recursive: true, force: true });
if (failed) console.log(out.slice(-2000));
console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
