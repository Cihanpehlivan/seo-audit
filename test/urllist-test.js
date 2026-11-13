// Tests for the old address list (v0.12.0): reading exports, cleaning, merging, asking the old site,
// the old page set with list pages, traffic order, Excel, project file, lock after launch.
// Every CSV here is made in the test. No real export goes into the repository.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readList, cleanList, mergeSources, toFetch, trafficCompare, validateList, withListPages, listResults, makeSource, latePaths, withLatePages, hasProof } from '../src/urllist.js';
import { compareCrawls } from '../src/compare.js';
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

// ---------- v0.12.1: late addresses (decision 7b) ----------
await check('geç adres: eski taramada ve liste taramasında olmayan yol; içeriksiz sayfa; kanıt eşiği', () => {
  const oldRes = { meta: { startUrl: 'https://eski.com/', host: 'eski.com' }, pages: [{ url: 'https://eski.com/a', status: 200, contentType: 'text/html', title: 'A' }] };
  const listRes = { pages: [{ url: 'https://eski.com/g', status: 404, contentType: 'text/html' }] };
  const m = new Map([['/a', {}], ['/g', {}], ['/b', { clicks: 3 }], ['/c', {}]]);
  const late = latePaths(m, oldRes, listRes);
  assert.deepEqual([...late].sort(), ['/b', '/c']);
  const out = withLatePages(oldRes, late);
  const b = out.pages.find((p) => p.url === 'https://eski.com/b');
  assert.deepEqual([b.late, b.title, b.simhash, b.inlinks], [true, '', null, 0]);
  const P = cfg.lateProof;
  assert.deepEqual([hasProof({ clicks: 3 }, P), hasProof({ impressions: 0 }, P), hasProof({}, P), hasProof(null, P), hasProof({ views: 2 }, { ...P, views: null })], [true, false, false, false, false]);
});
await check('geç adres karşılaştırmada: içerik farkı yok, sayılara girmez, staging isteği işareti yok', () => {
  const o = (p, x = {}) => ({ url: `https://eski.com${p}`, status: 200, contentType: 'text/html', title: p, ...x });
  const oldRes = withLatePages({ meta: { startUrl: 'https://eski.com/', host: 'eski.com' }, pages: [o('/a'), o('/b')] }, new Set(['/c', '/d']));
  const heir = { meta: { startUrl: 'https://yeni.test/', host: 'yeni.test' }, pages: [
    { url: 'https://yeni.test/a', status: 200, contentType: 'text/html', title: '/a' }, { url: 'https://yeni.test/c', status: 200, contentType: 'text/html', title: 'Yeni C', h1: ['C'] }] };
  const cmp = compareCrawls(oldRes, [heir]);
  // /c is on the heir: an old page without content is no \"İçerik değişti\". /d is missing: lost, no request.
  assert.equal(cmp.rows.changed.length, 0);
  const d = cmp.rows.lost.find((r) => r.path === '/d');
  assert.deepEqual([d.late, !!d.probe], [true, false]);
  assert.equal(cmp.rows.lost.find((r) => r.path === '/b').probe, true);
  assert.deepEqual([cmp.summary.oldPages, cmp.summary.late, cmp.summary.same, cmp.summary.kept], [2, 2, 1, 50]);
});

// ---------- API: the old site, a list, the requests, the map ----------
const [oldSrv, heirSrv] = await startMigrationSites();
const OLD = `http://127.0.0.1:${oldSrv.address().port}`;
const HEIR = `http://localhost:${heirSrv.address().port}/`;
// The old site counts every request: a list request must never leave the old host.
const seen = [];
oldSrv.on('request', (req) => seen.push(req.url));
const seenHeir = []; // v0.12.1: staging requests (a late address must not get one)
heirSrv.on('request', (req) => seenHeir.push(req.url));
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
  assert.deepEqual(v.counts, { crawl: 2, found: 1, gone: 1, redirect: 2, redirectBad: 0, nothtml: 1, error: 0, blocked: 0, pending: 0, limit: 0, late: 0 });
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
  // 404 and text addresses are not old pages and get no row. v0.12.2 (decision 5 changed): a redirecting address
  // is not an old page (oldPages above), but it gets a redirect row (test/redirects-test.js).
  for (const p of ['/eski-katalog', '/notlar']) assert.ok(!m.map.rows.some((r) => r.path === p), p);
  for (const p of ['/eski-indirim', '/disari']) assert.equal(m.map.rows.find((r) => r.path === p)?.kind, 'follow', p);
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
// ---------- v0.12.1: traffic order in the work list, the launch list and the live check ----------
// A second source gives traffic to more old pages (crawled pages: no new request).
const sortedByTraffic = (list, get = (x) => x.traffic) => {
  const val = (t) => (t ? [t.c ?? -1, t.i ?? -1, t.v ?? -1, t.l ?? -1] : [-1, -1, -1, -1]);
  for (let i = 1; i < list.length; i++) {
    const [a, b] = [val(get(list[i - 1])), val(get(list[i]))];
    const j = a.findIndex((x, k) => x !== b[k]);
    if (j >= 0 && a[j] < b[j]) return `${list[i - 1].path || list[i - 1].page || list[i - 1].old} → ${list[i].path || list[i].page || list[i].old}`;
  }
  return '';
};
const CSV2 = ['Top pages,Clicks', `http://${host}/fr/x,5`, `http://${host}/fr/y,80`, `http://${host}/tr/c,15`, `http://${host}/tr/a,300`].join('\n');
await check('Yapılacaklar: her yerde işler trafiğe göre sıralı, satır trafik taşır', async () => {
  const add = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV2, name: 'Search Console 2' } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  // The heir of the test has few pages: its tasks wait ("hazır değil"). Accept it, so the decisions get their own card.
  assert.equal((await api(`/api/projects/${pid}/ready`, { method: 'POST', body: { site: 'heir', ok: true } })).status, 200);
  const t = (await api(`/api/projects/${pid}/match`)).data.todo;
  let withTraffic = 0;
  for (const pl of t.places) {
    const list = t.items.filter((i) => i.placeKey === pl.key && !i.held);
    assert.equal(sortedByTraffic(list), '', `${pl.key}: ${sortedByTraffic(list)}`);
    if (list.filter((i) => i.traffic).length >= 2) withTraffic++;
  }
  assert.ok(withTraffic >= 1, 'iki trafikli işi olan yer yok');
  const fr = t.items.find((i) => i.path === '/fr/y');
  assert.deepEqual(fr?.traffic, { c: 80 });
});
await check('Canlıya çıkış: \"Karar bekleyen\" satırları trafiğe göre sıralı', async () => {
  const L = (await api(`/api/projects/${pid}/match`)).data.launch;
  const it = L.groups.find((g) => g.key === 'decide').items.find((i) => i.kind === 'map-pending');
  assert.ok(it && it.list.filter((x) => x.traffic).length >= 2, 'trafikli satır yok');
  assert.equal(sortedByTraffic(it.list), '');
  assert.equal(it.list[0].page.endsWith('/fr/z'), true, it.list[0].page);
});
await check('Excel: \"Yapılacaklar\" sayfasında trafik sütunu, satırlar yere ve trafiğe göre', async () => {
  const r = await fetch(`${base}/api/projects/${pid}/excel`);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('Yapılacaklar');
  const head = ws.getRow(1).values;
  const ci = head.indexOf('Tıklama'), wi = head.indexOf('Yer'), ui = head.indexOf('Eski URL');
  assert.ok(ci > 0, head.join(','));
  const rows = [];
  ws.eachRow((row, n) => { if (n > 1) rows.push({ where: row.values[wi], old: row.values[ui], traffic: row.values[ci] == null ? null : { c: row.values[ci] } }); });
  const places = [...new Set(rows.map((x) => x.where))];
  for (const w of places) {
    const list = rows.filter((x) => x.where === w);
    assert.equal(sortedByTraffic(list), '', w);
    // One block per place: the rows of a place are not mixed with other places.
    assert.equal(rows.findIndex((x) => x.where === w) + list.length - 1, rows.map((x) => x.where).lastIndexOf(w), w);
  }
  assert.ok(rows.some((x) => x.old?.endsWith('/fr/y') && x.traffic?.c === 80));
  const ln = wb.getWorksheet('Canlıya çıkış');
  assert.ok(ln.getRow(1).values.includes('Tıklama'), 'Canlıya çıkış sayfasında Tıklama yok');
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
await check('Canlı doğrulama: her grupta satırlar trafiğe göre sıralı, satır trafik taşır', async () => {
  const V = (await api(`/api/projects/${pid}/verify`)).data;
  let n = 0;
  for (const g of V.groups) for (const it of g.items.filter((x) => x.listKind === 'redirect')) {
    assert.equal(sortedByTraffic(it.list), '', `${it.kind}: ${sortedByTraffic(it.list)}`);
    if (it.list.filter((x) => x.traffic).length >= 2) n++;
  }
  assert.ok(n >= 1, 'iki trafikli satırı olan liste yok');
  const all = V.groups.flatMap((g) => g.items.flatMap((i) => i.list));
  assert.deepEqual(all.find((x) => x.old?.endsWith('/fr/y'))?.traffic, { c: 80 });
});
await check('Excel: \"Canlı doğrulama\" sayfasında trafik sütunu', async () => {
  const r = await fetch(`${base}/api/projects/${pid}/excel`);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('Canlı doğrulama');
  const head = ws.getRow(1).values;
  const ci = head.indexOf('Tıklama'), ai = head.indexOf('Adres');
  assert.ok(ci > 0, head.join(','));
  let found = false;
  ws.eachRow((row, n) => { if (n > 1 && String(row.values[ai] || '').endsWith('/fr/z')) found = row.values[ci] === 200; });
  assert.ok(found, '/fr/z satırında 200 tıklama yok');
});
// Late addresses after launch: /about-eski (404, clicks: proof), /gec-sayfa (200 on the live domain), /sonra-gelen
// (plain list of the launch test above: no proof). In the test the live old domain is still the old server (no DNS switch).
let lateSrc;
await check('çıkıştan sonra gelen adres: 301 haritasında \"İçerik yok\" satırı, adres benzerliği ile öneri, staging isteği yok', async () => {
  const add = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: ['Top pages,Clicks', `http://${host}/about-eski,25`, `http://${host}/gec-sayfa,9`].join('\n'), name: 'Search Console 3' } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  lateSrc = add.data?.added && (await api(`/api/projects/${pid}/urllist`)).data.sources.at(-1).id;
  const v = (await api(`/api/projects/${pid}/urllist`)).data;
  assert.deepEqual(['/about-eski', '/gec-sayfa', '/sonra-gelen'].map((p) => v.rows.find((x) => x.path === p)?.result), ['late', 'late', 'late']);
  seenHeir.length = 0; seen.length = 0;
  const m = (await api(`/api/projects/${pid}/match?fresh=1`)).data;
  for (const p of ['/about-eski', '/gec-sayfa', '/sonra-gelen']) {
    assert.ok(!seenHeir.includes(p), `staging isteği: ${p}`);
    assert.ok(!seen.includes(p), `eski site isteği: ${p}`);
  }
  assert.ok(seenHeir.length > 0, 'eşleştirme hiç istek atmadı: test anlamsız');
  const row = m.map.rows.find((r) => r.path === '/about-eski');
  assert.equal(row.late, true);
  assert.equal(row.candidates[0]?.path, '/about');
  assert.match(row.candidates[0].why, /Slug ortak: about/);
  assert.deepEqual(row.traffic, { c: 25 });
  assert.equal(m.map.rows.find((r) => r.path === '/sonra-gelen')?.late, true);
  // The counts do not see the late addresses.
  assert.deepEqual([m.summary.oldPages, m.summary.late], [10, 3]);
});
await check('canlı doğrulama: geç adres canlıda istenir; kanıt varsa kritik, yoksa kontrol edilemedi, açılıyorsa tamam', async () => {
  seen.length = 0;
  const V = (await api(`/api/projects/${pid}/verify?fresh=1`)).data;
  for (const p of ['/about-eski', '/gec-sayfa', '/sonra-gelen']) assert.ok(seen.includes(p), `canlıda istenmedi: ${p}`);
  const kindOf = (p) => V.groups.flatMap((g) => g.items).find((i) => i.listKind === 'redirect' && i.list.some((x) => x.old.endsWith(p)));
  assert.deepEqual([kindOf('/about-eski')?.kind, kindOf('/about-eski')?.group], ['lost', 'critical']);
  assert.deepEqual([kindOf('/sonra-gelen')?.kind, kindOf('/sonra-gelen')?.group], ['late-unproven', 'unknown']);
  assert.equal(kindOf('/gec-sayfa')?.kind, 'ok-open');
  assert.equal(kindOf('/about-eski').list.find((x) => x.old.endsWith('/about-eski')).src, 'Karar yok · liste');
});
await check('geç adres: karar canlı beklentiyi değiştirir; liste kalkınca karar kalır; Excel \"İçerik yok\"', async () => {
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/about-eski': { site: 'heir', path: '/about', src: 'oneri' } } } });
  const V = (await api(`/api/projects/${pid}/verify?fresh=1`)).data;
  const it = V.groups.flatMap((g) => g.items).find((i) => i.listKind === 'redirect' && i.list.some((x) => x.old.endsWith('/about-eski')));
  assert.equal(it.kind, 'no301'); // a 301 is expected; the live domain gives 404
  const r = await fetch(`${base}/api/projects/${pid}/excel`);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('301 haritası');
  const head = ws.getRow(1).values, fi = head.indexOf('Eski sayfa nereden'), oi = head.indexOf('Eski URL');
  let found = '';
  ws.eachRow((row, n) => { if (n > 1 && String(row.values[oi]).endsWith('/about-eski')) found = row.values[fi]; });
  assert.equal(found, 'Liste (çıkıştan sonra, içerik yok)');
  await api(`/api/projects/${pid}/urllist/${lateSrc}`, { method: 'DELETE' });
  const m = (await api(`/api/projects/${pid}/match`)).data;
  assert.ok(!m.map.rows.some((x) => x.path === '/about-eski'));
  assert.deepEqual((await api(`/api/projects/${pid}`)).data.project.map['/about-eski'], { site: 'heir', path: '/about', src: 'oneri' });
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
