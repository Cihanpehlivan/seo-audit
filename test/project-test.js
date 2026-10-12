// Tests for migration projects (v0.7.0): definition, crawl per site, matching with the 301 check, export.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateProject, engineRules, ProjectStore } from '../src/projects.js';
import { Store } from '../src/store.js';
import { startMigrationSites, TR_HOST } from './fixture-migration.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Proje testi');

const DEF = {
  name: 'Örnek taşıma', structure: 'domains',
  sites: [{ role: 'heir', url: 'staging.ornek.com' }, { role: 'old', url: 'https://www.eski.com' }, { role: 'extra', key: 'tr', name: 'Türkçe', url: 'https://tr.ornek.com', live: 'https://TR.eski.com/x' }],
  rules: [{ from: '/tr/', site: 'tr', to: '/*' }, { from: '/fr/*', drop: true }, { from: '/tr/*', site: 'heir' }],
};
await check('tanım: siteler sıralanır, adres ve canlı alan adı temizlenir', () => {
  const p = validateProject(DEF);
  assert.deepEqual(p.sites.map((s) => s.role), ['old', 'heir', 'extra']);
  assert.equal(p.sites[1].url, 'https://staging.ornek.com/');
  assert.equal(p.sites[2].live, 'tr.eski.com');
  assert.deepEqual(p.rules, [{ from: '/tr/*', site: 'tr', to: '/*' }, { from: '/fr/*', drop: true }]); // same "from" twice: first stays
});
await check('tanım: hatalar açık mesaj verir', () => {
  assert.throws(() => validateProject({ ...DEF, name: ' ' }), /Proje adını/);
  assert.throws(() => validateProject({ ...DEF, sites: DEF.sites.filter((x) => x.role !== 'old') }), /eski site olmalı/);
  assert.throws(() => validateProject({ ...DEF, rules: [{ from: '/a/*', site: 'yok' }] }), /hedef site projede yok/);
  assert.throws(() => validateProject({ ...DEF, rules: [{ from: 'a' }] }), /Kural 1/);
  assert.throws(() => validateProject({ ...DEF, sites: [...DEF.sites, { role: 'extra', key: 'tr', url: '' }] }), /anahtarı/);
  assert.throws(() => validateProject(DEF, { maxExtras: 0 }), /ek site/);
});
await check('tanım: eski \'paths\' yapısı \'same\' okunur (v0.10.0)', () => {
  assert.equal(validateProject({ ...DEF, structure: 'paths' }).structure, 'same');
  assert.equal(validateProject(DEF).structure, 'domains');
});
await check('kural: site anahtarı tarama alan adına çevrilir', () => {
  const p = validateProject(DEF);
  assert.deepEqual(engineRules(p, (k) => (k === 'tr' ? 'tr-staging.ornek.com' : '')), [{ from: '/tr/*', host: 'tr-staging.ornek.com', to: '/*' }, { from: '/fr/*', drop: true }]);
});
await check('kayıt: güncellemeler sırayla yazılır', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-prj-'));
  const ps = new ProjectStore(dir); await ps.init();
  const p = await ps.create(validateProject(DEF));
  await Promise.all(Array.from({ length: 10 }, (_, i) => ps.update(p.id, (q) => { q.rules.push({ from: `/x${i}`, drop: true }); })));
  assert.equal((await ps.get(p.id)).rules.length, 12);
  await rm(dir, { recursive: true, force: true });
});

// ---------- API: create, crawl, match ----------
const [oldSrv, heirSrv] = await startMigrationSites();
const OLD = `http://127.0.0.1:${oldSrv.address().port}/`;
const HEIR = `http://localhost:${heirSrv.address().port}/`; // another host name for the same machine
const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-prj-'));
// The Turkish site is a saved crawl (no server): the project links it as an existing crawl.
const store = new Store(dir); await store.init();
const trPage = (p) => ({ url: `https://${TR_HOST}${p}`, status: 200, finalStatus: 200, contentType: 'text/html', redirectChain: [], title: p === '/' ? 'Türkçe' : p.slice(1).toUpperCase(), metaDescription: 'x açıklaması', h1: ['x'], metaRobots: '', inlinks: 1 });
await store.save('tr-kayit', 'yeni', { meta: { host: TR_HOST, startUrl: `https://${TR_HOST}/`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }, pages: ['/', '/a', '/b', '/c'].map(trPage) });

const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await freePort();
const srv = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CRAWL_DIR: dir, PUBLIC_MODE: '', APP_USER: '', APP_PASS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const waitDone = async (id, key) => {
  for (let i = 0; i < 100; i++) {
    const { data } = await api(`/api/projects/${id}`);
    if (data.status[key].state !== 'running' && !data.project.sites.find((s) => s.key === key).pendingCrawlId) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('tarama bitmedi');
};

let pid;
const def = { name: 'Test taşıma', structure: 'domains', rules: [],
  sites: [{ role: 'old', url: OLD }, { role: 'heir', url: HEIR }, { role: 'extra', key: 'tr', name: 'Türkçe', url: `https://${TR_HOST}/`, live: '' }] };
await check('API: proje oluşur, siteler "taranmadı" durumunda', async () => {
  const { status, data } = await api('/api/projects', { method: 'POST', body: def });
  assert.equal(status, 201); pid = data.id;
  const s = (await api(`/api/projects/${pid}`)).data.status;
  assert.deepEqual([s.old.state, s.heir.state, s.tr.state], ['none', 'none', 'none']);
});
await check('API: taranmayan site ile eşleştirme nedeni ve eksik siteyi söyler', async () => {
  const { status, data } = await api(`/api/projects/${pid}/match`);
  assert.equal(status, 409);
  assert.match(data.error, /taranmadı/); assert.deepEqual(data.need, ['old', 'heir']);
});
await check('API: var olan tarama siteye bağlanır', async () => {
  const p = (await api(`/api/projects/${pid}`)).data.project;
  p.sites.find((s) => s.key === 'tr').crawlId = 'tr-kayit';
  const { data } = await api(`/api/projects/${pid}`, { method: 'PUT', body: p });
  assert.deepEqual([data.status.tr.state, data.status.tr.pages], ['done', 4]);
});
await check('API: "Tara" düğmesi taramayı başlatır, bitince tarama projeye yazılır', async () => {
  for (const key of ['old', 'heir']) {
    const { status } = await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } });
    assert.equal(status, 201);
    await waitDone(pid, key);
  }
  const { data } = await api(`/api/projects/${pid}`);
  assert.deepEqual([data.status.old.state, data.status.old.pages, data.status.heir.state], ['done', 9, 'done']);
  assert.ok(data.project.sites.every((s) => s.crawlId));
});
let m;
await check('eşleştirme: önerilen taşıma kendiliğinden uygulanır, bulunamayan bölüm karar ister', async () => {
  const r = await api(`/api/projects/${pid}/match`);
  assert.equal(r.status, 200, JSON.stringify(r.data)); m = r.data;
  const sec = Object.fromEntries(m.sections.map((x) => [x.from, x]));
  assert.deepEqual(Object.keys(sec), ['/*', '/tr/*', '/fr/*']);
  assert.deepEqual([sec['/tr/*'].auto, sec['/tr/*'].current, sec['/tr/*'].pages], [true, { site: 'tr', to: '/*' }, 4]);
  // v0.7.1: not found is not removed. No "bölüm kaldırıldı" suggestion, no hint (no option finds a page).
  assert.deepEqual([sec['/fr/*'].needsDecision, sec['/fr/*'].suggestion.notFound, sec['/fr/*'].suggestion.drop, sec['/fr/*'].suggestion.site], [true, true, undefined, undefined]);
  assert.equal(sec['/fr/*'].found, 0);
  assert.ok(sec['/tr/*'].options.some((o) => o.site === 'tr' && o.to === '/*' && o.hits === 4));
  assert.deepEqual([sec['/*'].pages, sec['/*'].found], [2, 2]);
  assert.deepEqual([sec['/tr/*'].found, sec['/tr/*'].no301, sec['/tr/*'].notarget], [4, 1, 0]);
});
await check('eşleştirme: bölüm satırı sayfaları listeler, bulunamayan önce gelir', () => {
  const sec = Object.fromEntries(m.sections.map((x) => [x.from, x]));
  const tr = sec['/tr/*'];
  assert.equal(tr.pageList.length, 4);
  assert.equal(tr.more, 0);
  const c = tr.pageList.find((g) => g.path === '/tr/c');
  assert.deepEqual([c.kind, c.found, c.url], ['no301', true, `https://${TR_HOST}/c`]);
  const fr = sec['/fr/*'];
  assert.deepEqual(fr.pageList.map((g) => [g.path, g.kind, g.found]), [['/fr/x', 'lost', false], ['/fr/y', 'lost', false], ['/fr/z', 'lost', false]]);
  assert.match(fr.pageList[0].url, /\/fr\/x$/); // the address the tool checked
  assert.match(fr.pageList[0].reason, /404/);
  const root = sec['/*'];
  assert.deepEqual(root.pageList.map((g) => [g.path, g.kind]), [['/', 'same'], ['/about', 'same']]);
  assert.match(root.pageList[1].url, /\/about$/);
});
await check('eşleştirme: 301 eski alan adına geçecek sitede kontrol edilir', () => {
  const path_ = (k) => m.rows[k].map((r) => r.path).sort();
  assert.deepEqual(path_('moved'), ['/tr', '/tr/a', '/tr/b']);
  assert.match(m.rows.moved.find((r) => r.path === '/tr/b').todo, /Zincir 2 adım/);
  assert.deepEqual(path_('no301'), ['/tr/c']);
  assert.equal(m.rows.no301[0].todo, `Eski alan adına geçecek sitede 301 kurun: /tr/c → https://${TR_HOST}/c`);
  assert.deepEqual(path_('lost'), ['/fr/x', '/fr/y', '/fr/z']);
  assert.equal(m.summary.same, 2);
});
await check('eşleştirme: karar kaydedilince bölüm kural olur', async () => {
  const p = (await api(`/api/projects/${pid}`)).data.project;
  p.rules = [{ from: '/fr/*', drop: true }];
  await api(`/api/projects/${pid}`, { method: 'PUT', body: p });
  const d = (await api(`/api/projects/${pid}/match`)).data;
  const fr = d.sections.find((x) => x.from === '/fr/*');
  assert.deepEqual([fr.rule, fr.auto, fr.needsDecision, fr.current], [true, false, false, { drop: true }]);
  assert.equal(d.summary.removed, 3);
});
await check('301 haritası: kural satırları hazır, bulunamayan sayfa öneri ister', async () => {
  const d = (await api(`/api/projects/${pid}/match`)).data;
  const st = Object.fromEntries(d.map.rows.map((r) => [r.path, r.status]));
  assert.deepEqual(st, { '/tr': 'rule', '/tr/a': 'rule', '/tr/b': 'rule', '/tr/c': 'rule', '/fr/x': 'none', '/fr/y': 'none', '/fr/z': 'none' });
  const c = d.map.rows.find((r) => r.path === '/tr/c');
  assert.deepEqual([c.installed, c.target.site, c.target.url], [false, 'tr', `https://${TR_HOST}/c`]);
  assert.deepEqual(d.map.noLive, ['tr']); // the Turkish site has no live domain in the project
});
await check('301 haritası: kararlar kaydedilir, geçersiz karar düşer, PUT haritayı silmez', async () => {
  const r = await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: {
    '/fr/x': { site: 'heir', path: '/about', src: 'elle' }, '/fr/y': { gone: true }, '/fr/z': { site: 'yok', path: '/a' } } } });
  assert.deepEqual([r.status, r.data.decisions], [200, 2]);
  const p = (await api(`/api/projects/${pid}`)).data.project;
  await api(`/api/projects/${pid}`, { method: 'PUT', body: { ...p, name: 'Test taşıma', map: {} } }); // the browser never changes the map with PUT
  const d = (await api(`/api/projects/${pid}/match`)).data;
  const x = d.map.rows.find((q) => q.path === '/fr/x');
  assert.deepEqual([x.status, x.target.url, x.warn], ['approved', `${OLD}about`, '']);
  assert.equal(d.map.rows.find((q) => q.path === '/fr/y').status, 'gone');
  assert.deepEqual([d.map.summary.approved, d.map.summary.gone, d.map.summary.none], [1, 1, 1]);
  assert.equal((await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: [] } })).status, 400);
});
await check('301 haritası: CSV sadece son listeyi verir', async () => {
  const res = await fetch(`${base}/api/projects/${pid}/map?format=csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /301-haritasi-127\.0\.0\.1\.csv/);
  const lines = (await res.text()).replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines.length, 7); // header + 4 rule + 1 approved + 1 gone
  assert.ok(lines.includes(`${OLD}fr/x,${OLD}about,301,Elle`));
  assert.ok(lines.includes(`${OLD}fr/y,,410,Onay`));
});
await check('yapılacaklar: işler yere göre gelir, site hazır sayılabilir, Excel sayfası var', async () => {
  const d = (await api(`/api/projects/${pid}/match`)).data;
  const keys = d.todo.places.map((p) => p.key);
  assert.deepEqual(keys, ['server', 'site:heir', 'site:tr', 'content', 'decide']);
  assert.equal(d.todo.places[0].title, '127.0.0.1 sunucusu');
  assert.equal(d.todo.total, d.todo.places.reduce((a, p) => a + p.n, 0));
  assert.equal(d.todo.places[0].tasks.find((t) => t.kind === '410')?.n, 1); // /fr/y kararı
  assert.ok(d.todo.items.every((i) => i.placeKey && i.label));
  assert.equal((await api(`/api/projects/${pid}/ready`, { method: 'POST', body: { site: 'old', ok: true } })).status, 400);
  const r = await api(`/api/projects/${pid}/ready`, { method: 'POST', body: { site: 'tr', ok: true } });
  assert.deepEqual([r.status, r.data.readyOk.tr], [200, 'tr-kayit']);
  const p = (await api(`/api/projects/${pid}`)).data.project;
  await api(`/api/projects/${pid}`, { method: 'PUT', body: p }); // PUT keeps the accepted site
  assert.equal((await api(`/api/projects/${pid}`)).data.project.readyOk.tr, 'tr-kayit');
  await api(`/api/projects/${pid}/ready`, { method: 'POST', body: { site: 'tr', ok: false } });
  assert.deepEqual((await api(`/api/projects/${pid}`)).data.project.readyOk, {});
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await (await fetch(`${base}/api/projects/${pid}/excel`)).arrayBuffer()));
  const ws = wb.getWorksheet('Yapılacaklar');
  assert.ok(ws, 'Yapılacaklar sayfası yok');
  assert.deepEqual(ws.getRow(1).values.slice(1, 7), ['Yer', 'Ekip', 'İş', 'Eski URL', 'Canlı URL', 'Kontrol edilen URL (staging)']);
  assert.equal(ws.rowCount - 1, d.todo.items.length);
});
await check('canlıya çıkış: liste match yanıtında ve Excel\'de (v0.10.0)', async () => {
  const d = (await api(`/api/projects/${pid}/match`)).data;
  assert.deepEqual(d.launch.groups.map((g) => g.key), ['critical', 'decide', 'switch', 'check']);
  assert.equal(d.launch.total, Object.values(d.launch.counts).reduce((a, b) => a + b, 0));
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await (await fetch(`${base}/api/projects/${pid}/excel`)).arrayBuffer()));
  const rows = d.launch.groups.flatMap((g) => g.items).reduce((a, it) => a + Math.max(1, it.list.length), 0);
  const ws = wb.getWorksheet('Canlıya çıkış');
  if (!rows) return assert.equal(ws, undefined);
  assert.ok(ws, 'Canlıya çıkış sayfası yok');
  assert.equal(ws.rowCount - 1, rows);
});
await check('API: Excel ve proje dosyası iner', async () => {
  const x = await fetch(`${base}/api/projects/${pid}/excel`);
  assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /spreadsheet/);
  const e = await fetch(`${base}/api/projects/${pid}/export`);
  assert.match(e.headers.get('content-disposition'), /proje-test-tasima\.json/);
  const j = await e.json();
  assert.equal(j.format, 'seo-audit-proje');
  assert.ok(!JSON.stringify(j).includes('pendingCrawlId'));
  const { status, data } = await api('/api/projects', { method: 'POST', body: j }); // "Proje yükle"
  assert.equal(status, 201); assert.notEqual(data.id, pid); assert.equal(data.rules.length, 1);
  assert.deepEqual(data.map['/fr/y'], { gone: true, src: 'oneri' }); // 301 map decisions travel with the file
});
await check('API: silinen tarama "silinmiş" görünür, tanım kalır', async () => {
  const p = (await api(`/api/projects/${pid}`)).data.project;
  await api(`/api/crawls/${p.sites.find((s) => s.key === 'heir').crawlId}`, { method: 'DELETE' });
  const { data } = await api(`/api/projects/${pid}`);
  assert.equal(data.status.heir.state, 'deleted');
  assert.equal((await api(`/api/projects/${pid}/match`)).status, 409);
});

srv.kill();
oldSrv.close(); heirSrv.close();
await rm(dir, { recursive: true, force: true });
if (failed) console.log(out.slice(-2000));
console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
