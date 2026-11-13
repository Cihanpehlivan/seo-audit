// Tests for old redirects (v0.12.2). The old site redirects an address (/indirim → /kampanya). After launch the old
// server rules are gone and the address gives 404. The 301 map gets a row that takes the new address of its target
// in one step (/indirim → /yeni/kampanya). The row follows the target's decision. Every CSV here is made in the test.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redirectInfo, oldRedirects } from '../src/urllist.js';
import { classify } from '../src/verify.js';
import { startRedirectSites, STG_HOST } from './fixture-migration.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Eski yönlendirme testi');

// ---------- Units (no requests) ----------
await check('yönlendirme verisi: aynı yol, başka alan adı, kırık hedef, zincir', () => {
  const ch = (...hops) => hops.map(([url, to]) => ({ url, status: 301, to }));
  assert.equal(redirectInfo({ url: 'http://eski.com/a/', redirectChain: ch(['http://eski.com/a/', 'https://www.eski.com/a']), finalUrl: 'https://www.eski.com/a', finalStatus: 200 }, 'eski.com').same, true);
  const off = redirectInfo({ url: 'http://eski.com/b', redirectChain: ch(['http://eski.com/b', 'http://eski.com/c'], ['http://eski.com/c', 'https://blog.dis.com/x']), finalUrl: 'https://blog.dis.com/x', finalStatus: 0 }, 'eski.com');
  assert.deepEqual([off.off, off.to, off.broken, off.hops], [true, 'https://blog.dis.com/x', false, 2]);
  assert.equal(redirectInfo({ url: 'http://eski.com/d', redirectChain: ch(['http://eski.com/d', 'http://eski.com/yok']), finalUrl: 'http://eski.com/yok', finalStatus: 404 }, 'eski.com').broken, true);
  const ok = redirectInfo({ url: 'http://eski.com/e', redirectChain: ch(['http://eski.com/e', 'http://eski.com/f'], ['http://eski.com/f', 'http://eski.com/g']), finalUrl: 'http://eski.com/g', finalStatus: 200, contentType: 'text/html' }, 'eski.com');
  assert.deepEqual([ok.toPath, ok.broken, ok.same, ok.hops], ['/g', false, false, 2]);
});
await check('yönlendirme kümesi: tarama ve liste; liste adresi listede kalmalı; robots engeli yok', () => {
  const r = (p, to, x = {}) => ({ url: `http://eski.com${p}`, status: 301, redirectChain: [{ url: `http://eski.com${p}`, status: 301, to: `http://eski.com${to}` }], finalUrl: `http://eski.com${to}`, finalStatus: 200, ...x });
  const oldCrawl = { meta: { host: 'eski.com', startUrl: 'http://eski.com/' }, pages: [r('/a', '/k'), { url: 'http://eski.com/k', status: 200 }, { url: 'http://eski.com/r', status: null, blockedByRobots: true }] };
  const listRes = { pages: [r('/l', '/k'), r('/m', '/k')] };
  const got = oldRedirects(oldCrawl, listRes, new Map([['/l', {}]]));
  assert.deepEqual(got.map((x) => [x.path, x.src, x.toPath]), [['/a', 'crawl', '/k'], ['/l', 'list', '/k']]);
  assert.deepEqual(oldRedirects(oldCrawl, listRes, new Map()).map((x) => x.path), ['/a']);
});
await check('canlı doğrulama sonucu: beklenen dış adrese tek adım 301 tamam, başka dış adres kontrol edilemedi', () => {
  const e = { expect: '301', target: 'https://dis.com/x' };
  assert.equal(classify(e, { chain: [301], left: 'https://dis.com/x' }, () => false), 'ok-left');
  assert.equal(classify(e, { chain: [302], left: 'https://dis.com/x' }, () => false), 'temp');
  assert.equal(classify(e, { chain: [301], left: 'https://dis.com/y' }, () => false), 'outside');
  assert.equal(classify({ expect: 'open' }, { chain: [301], left: 'https://dis.com/x' }, () => false), 'outside');
});

// ---------- API: the old site, the heir, the map ----------
const [oldSrv, heirSrv] = await startRedirectSites();
const OLD = `http://127.0.0.1:${oldSrv.address().port}`;
const HEIR = `http://localhost:${heirSrv.address().port}/`;
const seenOld = [], seenHeir = [];
oldSrv.on('request', (q) => seenOld.push(q.url));
heirSrv.on('request', (q) => seenHeir.push(q.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-redir-'));
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
const { data: created } = await api('/api/projects', { method: 'POST', body: { name: 'Yönlendirme testi', structure: 'same', rules: [],
  sites: [{ role: 'old', url: `${OLD}/` }, { role: 'heir', url: HEIR }] } });
const pid = created.id;
for (const key of ['old', 'heir']) {
  await api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key, options: { checks: false } } });
  await wait(async () => { const d = (await api(`/api/projects/${pid}`)).data; return d.status[key].state === 'done' && !d.project.sites.find((s) => s.key === key).pendingCrawlId; });
}
await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/kampanya': { site: 'heir', path: '/yeni/kampanya', src: 'oneri' }, '/hakkimizda': { gone: true, src: 'elle' } } } });
const match = async (q = '') => (await api(`/api/projects/${pid}/match${q}`)).data;
const rowOf = (m, p) => m.map.rows.find((r) => r.path === p);
const live = (p) => `${OLD}${p}`;

let first;
await check('taramada link ile bulunan yönlendirme: 301 haritasında hedefin yeni adresine tek adım', async () => {
  seenHeir.length = 0;
  first = await match('?fresh=1');
  const r = rowOf(first, '/eski-link');
  assert.ok(r, 'satır yok');
  assert.deepEqual([r.kind, r.status, r.target.url, r.follow.path, r.follow.src], ['follow', 'follow', live('/yeni/kampanya'), '/kampanya', 'crawl']);
  // Zincir: the row goes to the last address in one step. The target is on the heir at the same path (live old domain).
  const z = rowOf(first, '/eski-zincir');
  assert.deepEqual([z.status, z.target.url, z.follow.hops], ['follow', live('/urun'), 2]);
  // The matching asks staging nothing for a redirect address (no new staging request).
  for (const p of ['/eski-link', '/eski-zincir', '/eski-sil', '/eski-ana']) assert.ok(!seenHeir.includes(p), `staging isteği: ${p}`);
});
await check('satır yok: kırık hedef, yeni sitede aynı adreste sayfa; sayılar yönlendirmeyi eski sayfa saymaz', async () => {
  assert.ok(!rowOf(first, '/eski-kirik'), '/eski-kirik');
  assert.ok(!rowOf(first, '/eski-var'), '/eski-var');
  assert.equal(first.summary.oldPages, 4); // /, /kampanya, /urun, /hakkimizda: the 13 redirect addresses are not old pages
  // The comparison has no row for a redirect address ("Yönleniyor" or another): one row per path in the map.
  const cmpPaths = Object.values(first.rows).filter(Array.isArray).flat().map((r) => r.path);
  for (const p of ['/eski-link', '/eski-kurulu', '/eski-yanlis']) assert.ok(!cmpPaths.includes(p), p);
  const paths = first.map.rows.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
});
await check('hedefin kararı: 410 izlenir, ana sayfa uyarı alır, staging kurulu ve başka adres görünür', async () => {
  const s = rowOf(first, '/eski-sil');
  assert.deepEqual([s.status, s.gone, s.target], ['follow', true, null]);
  const a = rowOf(first, '/eski-ana');
  assert.equal(a.target.url, live('/')); assert.match(a.warn, /soft 404/);
  assert.equal(rowOf(first, '/eski-kurulu').staging, 'installed');
  const y = rowOf(first, '/eski-yanlis');
  assert.deepEqual([y.staging, new URL(y.stagingTo).pathname], ['other', '/urun']);
  assert.deepEqual([first.map.summary.follow, first.map.summary.wait], [6, 0]);
});
await check('başka alan adı: onay bekler (dış adres); staging alan adı: öneri yok', async () => {
  const d = rowOf(first, '/eski-dis');
  assert.deepEqual([d.status, d.target.url, d.candidates[0].ext], ['pending', 'http://baska.invalid/x', true]);
  const g = rowOf(first, '/eski-stg');
  assert.deepEqual([g.status, g.target], ['none', null]);
  assert.match(g.why, /staging/);
  assert.ok(!first.map.rows.some((r) => r.target?.url?.includes(STG_HOST)), 'staging hedefi');
});
await check('hedefin kararı değişince satır değişir; karar yoksa bekler; satırın kendi kararı kazanır ve geri alınır', async () => {
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/kampanya': { site: 'heir', path: '/urun', src: 'elle' } } } });
  assert.equal(rowOf(await match(), '/eski-link').target.url, live('/urun'));
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/kampanya': null } } });
  let m = await match();
  const w = rowOf(m, '/eski-link');
  assert.deepEqual([rowOf(m, '/kampanya').status, w.status, w.target], ['pending', 'wait', null]);
  assert.equal(w.hint, rowOf(m, '/kampanya').target.url);
  // A waiting row is no extra decision: the Launch list and the work list count the target row only.
  const decide = m.launch.groups.find((g) => g.key === 'decide')?.items.find((i) => i.kind === 'map-pending');
  assert.ok(!decide?.list.some((x) => x.page.endsWith('/eski-link')), 'bekleyen satır karar sayıldı');
  assert.ok(!m.todo.items.some((i) => i.path === '/eski-link'), 'bekleyen satır iş oldu');
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/kampanya': { site: 'heir', path: '/yeni/kampanya', src: 'oneri' }, '/eski-link': { gone: true, src: 'elle' } } } });
  m = await match();
  assert.equal(rowOf(m, '/eski-link').status, 'gone');
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/eski-link': null } } });
  assert.equal(rowOf(await match(), '/eski-link').status, 'follow');
});
await check('Yapılacaklar: sunucuda 301 kurun (staging kurulu olan hariç), 410; CSV ve Excel kaynağı "Eski yönlendirme"', async () => {
  const m = await match();
  const srvItems = m.todo.items.filter((i) => i.place === 'server');
  const it = srvItems.find((i) => i.path === '/eski-link');
  assert.deepEqual([it?.task, it?.liveUrl], ['301', live('/yeni/kampanya')]);
  assert.equal(srvItems.find((i) => i.path === '/eski-sil')?.task, '410');
  assert.ok(!srvItems.some((i) => i.path === '/eski-kurulu'), 'staging kurulu ama iş var');
  assert.match(srvItems.find((i) => i.path === '/eski-yanlis').note, /Staging başka adrese/);
  const csv = await (await fetch(`${base}/api/projects/${pid}/map?format=csv`)).text();
  assert.ok(csv.includes(`${live('/eski-link')},${live('/yeni/kampanya')},301,Eski yönlendirme`), csv);
  assert.ok(csv.includes(`${live('/eski-sil')},,410,Eski yönlendirme`));
  assert.ok(!csv.includes('/eski-dis,'), 'onaysız dış adres CSV\'de');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await (await fetch(`${base}/api/projects/${pid}/excel`)).arrayBuffer()));
  const ws = wb.getWorksheet('301 haritası');
  const head = ws.getRow(1).values;
  const [oi, si, fi, wi] = ['Eski URL', 'Kaynak', 'Eski sayfa nereden', 'Neden'].map((h) => head.indexOf(h));
  let row = null;
  ws.eachRow((r, n) => { if (n > 1 && r.values[oi] === live('/eski-link')) row = r.values; });
  assert.deepEqual([row?.[si], row?.[fi]], ['Eski yönlendirme', 'Eski yönlendirme (tarama)']);
  assert.match(String(row[wi]), /Eski sitede → \/kampanya/);
});

// ---------- The old address list ----------
const host = new URL(OLD).host;
const CSV = ['Top pages,Clicks', `http://${host}/eski-indirim,40`, `http://${host}/eski-gizli,12`, `http://${host}/eski-dis-liste,3`].join('\n');
let src;
await check('liste adresi: yönlenen adres satır alır, trafik ve "Listeden" taşır; hedefi eski sayfa değilse adresinden öneri', async () => {
  const before = (await match()).summary.oldPages;
  const add = await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  src = (await api(`/api/projects/${pid}/urllist`)).data.sources[0].id;
  await api(`/api/projects/${pid}/urllist/fetch`, { method: 'POST', body: {} });
  await wait(async () => (await api(`/api/projects/${pid}`)).data.listState.state === 'done');
  const m = await match();
  const r = rowOf(m, '/eski-indirim');
  assert.deepEqual([r.status, r.target.url, r.fromList, r.traffic, r.follow.src], ['follow', live('/yeni/kampanya'), true, { c: 40 }, 'list']);
  const g = rowOf(m, '/eski-gizli');
  assert.equal(g.status, 'pending');
  assert.equal(g.candidates[0].path, '/gizli-kampanya');
  assert.match(g.candidates[0].why, /Eski hedef \/gizli/);
  const d = rowOf(m, '/eski-dis-liste');
  assert.deepEqual([d.status, d.target.url], ['pending', 'http://baska.example/y']);
  assert.equal(m.summary.oldPages, before); // the redirects are not old pages
  const v = (await api(`/api/projects/${pid}/urllist`)).data;
  assert.equal(v.rows.find((x) => x.path === '/eski-indirim').result, 'redirect');
});
await check('liste değişir, karar kalır: kaynak silinince satır düşer, satırın kararı silinmez, liste gelince geri gelir', async () => {
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/eski-indirim': { site: 'heir', path: '/urun', src: 'elle' } } } });
  await api(`/api/projects/${pid}/urllist/${src}`, { method: 'DELETE' });
  const m = await match();
  assert.ok(!rowOf(m, '/eski-indirim'));
  assert.equal(m.map.summary.stale, 1);
  assert.deepEqual((await api(`/api/projects/${pid}`)).data.project.map['/eski-indirim'], { site: 'heir', path: '/urun', src: 'elle' });
  await api(`/api/projects/${pid}/urllist`, { method: 'POST', body: { text: CSV } });
  assert.equal(rowOf(await match(), '/eski-indirim').status, 'approved');
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/eski-indirim': null } } });
});

// ---------- After launch: the live check ----------
await check('canlı doğrulama: yönlenen adresler beklenen listede, istek atmadan kurulur; eski site ve staging istek almaz', async () => {
  await api(`/api/projects/${pid}/map`, { method: 'POST', body: { set: { '/eski-dis': { url: 'http://baska.invalid/x', src: 'oneri' } } } });
  await api(`/api/projects/${pid}/launch`, { method: 'POST', body: { at: '2026-11-20' } });
  seenHeir.length = 0;
  // In the test the live old domain is still the old server (no DNS switch): it gives the old redirects.
  const V = (await api(`/api/projects/${pid}/verify?fresh=1`)).data;
  assert.equal(seenHeir.length, 0, 'staging isteği');
  const all = V.groups.flatMap((g) => g.items.filter((i) => i.listKind === 'redirect').map((i) => i.list.map((x) => ({ ...x, kind: i.kind })))).flat();
  const of = (p) => all.find((x) => x.old === live(p));
  assert.deepEqual([of('/eski-link')?.src, of('/eski-link')?.expect], ['Eski yönlendirme', live('/yeni/kampanya')]);
  assert.equal(of('/eski-link').kind, 'wrong-target'); // the old server still sends it to /kampanya
  assert.deepEqual([of('/eski-sil')?.src, of('/eski-sil')?.expect], ['Eski yönlendirme · 410', '410']);
  assert.equal(of('/eski-indirim')?.src, 'Eski yönlendirme');
  assert.deepEqual([of('/eski-dis')?.src, of('/eski-dis')?.kind], ['Onay', 'ok-left']);
  assert.equal(of('/eski-gizli')?.src, 'Karar yok · eski yönlendirme');
  assert.ok(!of('/eski-kirik') && !of('/eski-var'), 'satır olmamalı');
});
await check('çıkıştan sonra: yönlendirme satırları çıkış öncesi taramalardan gelir, liste isteği yok', async () => {
  seenOld.length = 0;
  assert.equal((await api(`/api/projects/${pid}/urllist/fetch`, { method: 'POST', body: {} })).status, 409);
  const m = await match();
  assert.equal(rowOf(m, '/eski-indirim')?.status, 'follow');
  assert.equal(seenOld.length, 0);
});

srv.kill(); oldSrv.close(); heirSrv.close();
await rm(dir, { recursive: true, force: true });
if (failed) console.log(out.slice(-2000));
console.log(`${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
