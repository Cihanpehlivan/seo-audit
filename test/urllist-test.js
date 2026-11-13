// Tests for the old address list (v0.12.0): reading exports, cleaning, merging, asking the old site,
// the old page set with list pages, traffic order, Excel, project file, lock after launch.
// Every CSV here is made in the test. No real export goes into the repository.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readList, cleanList, mergeSources, toFetch, trafficCompare, validateList, withListPages, listResults, makeSource } from '../src/urllist.js';
import { loadConfig } from '../src/rules/index.js';
import { startMigrationSites } from './fixture-migration.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Eski adres listesi testi');
const cfg = loadConfig().urlList;

// ---------- Reading and cleaning (no requests) ----------
await check('okuma: Search Console (İngilizce), sütunlar ve sayılar', () => {
  const r = readList('Top pages,Clicks,Impressions,CTR,Position\nhttps://eski.com/a,1240,18300,6.8%,4.1\n', cfg);
  assert.equal(r.kind, 'gsc');
  assert.deepEqual(r.columns, { url: 'Top pages', clicks: 'Clicks', impressions: 'Impressions' });
  assert.deepEqual(r.rows, [{ raw: 'https://eski.com/a', clicks: 1240, impressions: 18300 }]);
});
await check('okuma: Türkçe sütun adları, noktalı virgül, binlik ayırıcı (1.240), BOM', () => {
  const r = readList('\uFEFFPopüler sayfalar;Tıklamalar;Gösterimler;TO;Konum\r\nhttps://eski.com/a;1.240;18.300;%6,8;4,1\r\n', cfg);
  assert.equal(r.kind, 'gsc');
  assert.deepEqual(r.rows[0], { raw: 'https://eski.com/a', clicks: 1240, impressions: 18300 });
});
await check('okuma: Analytics (sadece yol), backlink, başlıksız düz liste', () => {
  assert.equal(readList('Page path and screen class,Views\n/c,300\n', cfg).kind, 'ga');
  const b = readList('Target URL,Referring domains\nhttps://eski.com/k,14\n', cfg);
  assert.equal(b.kind, 'backlink'); assert.equal(b.rows[0].links, 14);
  const p = readList('/d\nhttps://eski.com/e\n', cfg);
  assert.equal(p.kind, 'plain'); assert.equal(p.rows.length, 2);
});
await check('okuma: sütun bulunamazsa hata sütunları verir, seçilen sütun kullanılır', () => {
  let err;
  try { readList('Adres X,Sayı Y\nfoo,1\n', cfg); } catch (e) { err = e; }
  assert.match(err.message, /Adres sütunu/); assert.deepEqual(err.columns, ['Adres X', 'Sayı Y']);
  const r = readList('Adres X,Sayı Y\nhttps://eski.com/z,7\n', cfg, { url: 'Adres X', clicks: 'Sayı Y' });
  assert.deepEqual(r.rows, [{ raw: 'https://eski.com/z', clicks: 7 }]);
});
await check('temizlik: www, http/https, sondaki / ve izleme parametresi aynı adres; başka alan adı ve dosya ayrılır', () => {
  const r = readList('Top pages,Clicks\nhttps://eski.com/a,100\nhttp://www.eski.com/a/?utm_source=x&gclid=1,20\n/b,3\nhttps://blog.eski.com/x,9\nhttps://eski.com/k.pdf,4\n(not set),1\n', cfg);
  const c = cleanList(r.rows, 'https://www.eski.com/');
  assert.deepEqual([...c.urls], [['/a', { clicks: 120 }], ['/b', { clicks: 3 }]]);
  assert.deepEqual(c.other, { 'blog.eski.com': 1 });
  assert.deepEqual([c.assets, c.invalid, c.merged], [1, 1, 1]);
});
await check('birleştirme: aynı ölçü toplanır, link veren alan adı büyük değeri alır; sıra trafiğe göre', () => {
  const mk = (id, rows) => makeSource({ text: id, kind: 'gsc', columns: {}, rows: 1, cleaned: { urls: new Map(rows), other: {}, invalid: 0, assets: 0, merged: 0 } }, id);
  const m = mergeSources([mk('l1', [['/a', { clicks: 10, links: 5 }], ['/b', { impressions: 50 }]]), mk('l2', [['/a', { clicks: 5, links: 3 }], ['/c', {}]])]);
  assert.deepEqual(m.get('/a'), { clicks: 15, links: 5, src: ['l1', 'l2'] });
  const order = [...m].sort((x, y) => trafficCompare(x[1], y[1])).map(([p]) => p);
  assert.deepEqual(order, ['/a', '/b', '/c']);
});
await check('istek listesi: taramadaki yol istenmez, trafiği yüksek olan önce, sınır kalanları ayırır', () => {
  const oldRes = { meta: { startUrl: 'https://eski.com/' }, pages: [{ url: 'https://eski.com/a', status: 200 }, { url: 'https://eski.com/r', status: 301 }] };
  const m = new Map([['/a', { clicks: 9 }], ['/r', {}], ['/x', { clicks: 1 }], ['/y', { clicks: 5 }], ['/z', {}]]);
  const w = toFetch(m, oldRes, 2);
  assert.deepEqual(w.urls, ['https://eski.com/y', 'https://eski.com/x']);
  assert.deepEqual([...w.rest], ['/z']);
});
await check('proje dosyası: bozuk satır ve kaynak düşer, satır sınırı uygulanır', () => {
  const L = validateList({ sources: [{ id: 'l1', kind: 'gsc', urls: [['/a', 5, null, null, null], ['yol-yok', 1], ['/b', -3, 'x']] }, { id: 'kötü' }, null] }, { maxRows: 10 });
  assert.equal(L.sources.length, 1);
  assert.deepEqual(L.sources[0].urls, [['/a', 5, null, null, null], ['/b', null, null, null, null]]);
  assert.equal(validateList({ sources: [{ id: 'l1', urls: [['/a'], ['/b'], ['/c']] }] }, { maxRows: 2 }).sources[0].urls.length, 2);
});
await check('eski sayfa kümesi: listeden 200 HTML sayfa eklenir, taramadaki sayfa ve listede olmayan sayfa eklenmez', () => {
  const oldRes = { meta: { startUrl: 'https://eski.com/' }, pages: [{ url: 'https://eski.com/a', status: 200, contentType: 'text/html' }] };
  const listRes = { pages: [
    { url: 'https://eski.com/a', status: 200, contentType: 'text/html' }, { url: 'https://eski.com/n', status: 200, contentType: 'text/html', inlinks: 4 },
    { url: 'https://eski.com/g', status: 404, contentType: 'text/html' }, { url: 'https://eski.com/q', status: 200, contentType: 'text/html' },
  ] };
  const m = new Map([['/a', {}], ['/n', { clicks: 3 }], ['/g', {}]]);
  const out = withListPages(oldRes, listRes, m);
  assert.deepEqual(out.pages.map((p) => [p.url, p.discoveredBy || 'crawl', p.inlinks ?? 0]), [['https://eski.com/a', 'crawl', 0], ['https://eski.com/n', 'list', 0]]);
  const R = listResults({ merged: m, oldRes, listRes });
  assert.deepEqual(R.rows.map((r) => [r.path, r.result]), [['/n', 'found'], ['/a', 'crawl'], ['/g', 'gone']]);
});

// ---------- API: the old site, a list, the requests, the map ----------
const [oldSrv, heirSrv] = await startMigrationSites();
const OLD = `http://127.0.0.1:${oldSrv.address().port}`;
const HEIR = `http://localhost:${heirSrv.address().port}/`;
// The old site counts every request: a list request must never leave the old host.
const seen = [];
oldSrv.on('request', (req) => seen.push(req.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-list-'));
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
const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('bitmedi'); };

const { data: created } = await api('/api/projects', { method: 'POST', body: { name: 'Liste testi', structure: 'same', rules: [],
  sites: [{ role: 'old', url: `${OLD}/` }, { role: 'heir', url: HEIR }] } });
const pid = created.id;
for (const key of ['old', 'heir']) {
  await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } });
  await wait(async () => { const d = (await api(`/api/projects/${pid}`)).data; return d.status[key].state === 'done' && !d.project.sites.find((s) => s.key === key).pendingCrawlId; });
}
const mapPaths = async () => (await api(`/api/projects/${pid}/match`)).data.map.rows.map((r) => r.path);

// The deney of the design: the page without links is not in the 301 map.
await check('deney: linksiz eski sayfa (200) liste olmadan 301 haritasında yok', async () => {
  assert.equal((await fetch(`${OLD}/eski-kampanya`)).status, 200);
  assert.ok(!(await mapPaths()).includes('/eski-kampanya'));
});

const host = new URL(OLD).host;
const CSV = ['Top pages,Clicks,Impressions',
  `http://${host}/eski-kampanya,120,900`, `http://${host}/about,50,400`, `http://${host}/about?utm_source=x,7,1`,
  `http://${host}/eski-indirim,30,100`, `http://${host}/eski-katalog,20,80`, `http://${host}/disari,10,50`,
  `http://${host}/notlar,5,10`, `http://${host}/fr/z,200,1500`, 'https://baska.example/y,3,3'].join('\n');

await check('API: önizleme sütunları gösterir ve kaydetmez', async () => {
  const { status, data } = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV, preview: true } });
  assert.equal(status, 200);
  assert.deepEqual([data.preview.kind, data.preview.addresses, data.preview.other, data.preview.merged], ['gsc', 7, 1, 1]);
  assert.equal((await api(`/api/projects/${pid}/urllist`)).data.sources.length, 0);
});
await check('API: liste eklenir, aynı liste ikinci kez eklenmez, sayılar doğru', async () => {
  const r = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV, name: 'Search Console', file: 'Pages.csv' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV } })).status, 409);
  const v = (await api(`/api/projects/${pid}/urllist`)).data;
  assert.deepEqual([v.addresses, v.otherCount, v.counts.crawl, v.counts.pending, v.toAsk], [7, 1, 2, 5, 5]);
  assert.deepEqual(v.rows.map((x) => x.path).slice(0, 3), ['/fr/z', '/eski-kampanya', '/about']); // traffic order
  assert.deepEqual(v.rows.find((x) => x.path === '/about').traffic, { c: 57, i: 401 });
});
let listCrawl;
await check('API: eski sitede istek; sadece taramada olmayan adresler, sadece eski site, sonuçlar doğru', async () => {
  seen.length = 0;
  const r = await api(`/api/projects/${pid}/urllist/fetch`, { method: 'POST', body: {} });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await wait(async () => (await api(`/api/projects/${pid}`)).data.listState.state === 'done');
  const v = (await api(`/api/projects/${pid}/urllist`)).data;
  assert.deepEqual(v.counts, { crawl: 2, found: 1, gone: 1, redirect: 2, nothtml: 1, error: 0, blocked: 0, pending: 0, limit: 0, late: 0 });
  // The five list addresses and the hop of the same-site redirect (/eski-indirim → /about). Nothing from the old crawl again.
  const asked = seen.filter((u) => u !== '/robots.txt').sort();
  assert.deepEqual(asked, ['/about', '/disari', '/eski-indirim', '/eski-kampanya', '/eski-katalog', '/notlar']);
  listCrawl = v.state.crawlId;
  const d = (await api(`/api/crawls/${listCrawl}`)).data;
  const off = d.pages.find((p) => p.url.endsWith('/disari'));
  assert.equal(off.offHost, true); assert.equal(off.error, null); // baska.example was not asked
  assert.equal(v.rows.find((x) => x.path === '/disari').detail, 'http://baska.example/x');
  assert.equal(d.pages.length, 5); // list mode: the redirect target is not a page of its own
});
await check('eski sayfa kümesi: linksiz sayfa 301 haritasına girer, trafik ve "Listeden" işareti taşır', async () => {
  const m = (await api(`/api/projects/${pid}/match`)).data;
  const row = m.map.rows.find((r) => r.path === '/eski-kampanya');
  assert.ok(row, 'satır yok');
  assert.equal(row.fromList, true); assert.deepEqual(row.traffic, { c: 120, i: 900 });
  assert.ok(row.candidates.some((c) => c.path === '/about'), 'öneri /about değil');
  assert.equal(m.summary.oldPages, 10);
  // Redirecting, 404 and text addresses are not old pages.
  for (const p of ['/eski-indirim', '/eski-katalog', '/disari', '/notlar']) assert.ok(!m.map.rows.some((r) => r.path === p), p);
});
await check('301 haritası: her durumda trafiği olan satır önce, yüksek trafik önce', async () => {
  const rows = (await api(`/api/projects/${pid}/match`)).data.map.rows;
  const val = (r) => (r.traffic ? [r.traffic.c ?? -1, r.traffic.i ?? -1] : [-1, -1]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].status !== rows[i - 1].status) continue;
    const [a, b] = [val(rows[i - 1]), val(rows[i])];
    assert.ok(a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]), `${rows[i - 1].path} → ${rows[i].path}`);
  }
  const fr = rows.filter((r) => r.path.startsWith('/fr/') && r.status === rows.find((x) => x.path === '/fr/z').status);
  assert.equal(fr[0].path, '/fr/z');
});
await check('Excel: 301 haritasında Tıklama ve Gösterim, "Eski adres listesi" sayfası', async () => {
  const r = await fetch(`${base}/api/projects/${pid}/excel`);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const map = wb.getWorksheet('301 haritası');
  const head = map.getRow(1).values.filter(Boolean);
  assert.ok(head.includes('Tıklama') && head.includes('Gösterim') && head.includes('Eski sayfa nereden'), head.join(','));
  const list = wb.getWorksheet('Eski adres listesi');
  assert.ok(list, 'sayfa yok');
  assert.deepEqual(list.getRow(2).values.slice(1, 3), ['/fr/z', 200]);
  assert.equal(list.rowCount, 8);
});
await check('liste değişir, karar kalır: kaynak silinince sayfa haritadan düşer, karar silinmez', async () => {
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/eski-kampanya': { gone: true } } } });
  const src = (await api(`/api/projects/${pid}/urllist`)).data.sources[0].id;
  const v = (await api(`/api/projects/${pid}/urllist/${src}`, { method: 'DELETE' })).data;
  assert.equal(v.sources.length, 0);
  const m = (await api(`/api/projects/${pid}/match`)).data;
  assert.ok(!m.map.rows.some((r) => r.path === '/eski-kampanya'));
  assert.equal(m.map.summary.stale, 1);
  assert.deepEqual((await api(`/api/projects/${pid}`)).data.project.map['/eski-kampanya'], { gone: true, src: 'oneri' });
  // The list comes back: the decision is used again (no new request: the list crawl is kept).
  await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV } });
  const m2 = (await api(`/api/projects/${pid}/match`)).data;
  assert.equal(m2.map.rows.find((r) => r.path === '/eski-kampanya').status, 'gone');
});
await check('Projeyi indir listeyi taşır, Proje yükle listeyi geri getirir', async () => {
  const exp = (await api(`/api/projects/${pid}/export`)).data;
  assert.equal(exp.urlList.crawlId, listCrawl);
  assert.ok(exp.urlList.sources[0].urls.some((u) => u[0] === '/eski-kampanya' && u[1] === 120));
  const { status, data } = await api('/api/projects', { method: 'POST', body: exp });
  assert.equal(status, 201);
  const v = (await api(`/api/projects/${data.id}/urllist`)).data;
  assert.deepEqual([v.sources.length, v.addresses, v.state.state, v.counts.found], [1, 7, 'done', 1]);
});
await check('çıkıştan sonra: istek yok (409), liste taraması kilitli, yeni kaynak "çıkıştan sonra geldi"', async () => {
  const L = await api(`/api/projects/${pid}/launch`, { method: 'POST', body: { at: '2026-11-20' } });
  assert.equal(L.data.project.launch.crawls.list, listCrawl);
  seen.length = 0;
  const r = await api(`/api/projects/${pid}/urllist/fetch`, { method: 'POST', body: {} });
  assert.equal(r.status, 409); assert.deepEqual(r.data.need, ['no-launch']);
  const add = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: `/sonra-gelen\nhttp://${host}/eski-kampanya` } });
  assert.equal(add.status, 201);
  const v = (await api(`/api/projects/${pid}/urllist`)).data;
  assert.equal(v.rows.find((x) => x.path === '/sonra-gelen').result, 'late');
  assert.equal(v.sources.find((s) => s.kind === 'plain').afterLaunch, true);
  assert.equal(seen.length, 0);
  // The live check still has the list page (expected list from the crawls before launch).
  const vr = await api(`/api/projects/${pid}/verify`);
  assert.equal(vr.status, 200);
  assert.ok(JSON.stringify(vr.data).includes('/eski-kampanya'));
});
await check('API: hatalar açık mesaj verir (boş liste, adres yok, geçersiz kaynak)', async () => {
  assert.match((await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: '  ' } })).data.error, /boş/);
  assert.match((await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: 'https://baska.example/a\n' } })).data.error, /başka alan adında/);
  assert.equal((await api(`/api/projects/${pid}/urllist/x..y`, { method: 'DELETE' })).status, 400);
});

srv.kill(); oldSrv.close(); heirSrv.close();
await rm(dir, { recursive: true, force: true });
if (failed) console.log(out.slice(-2000));
console.log(`${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
