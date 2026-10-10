// Tests for the old site vs new site comparison (Sprint 3, part 1). No network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { compareCrawls, pathKey, probeLost } from '../src/compare.js';
import { exportCompareExcel } from '../src/export.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Karşılaştırma testi');

const page = (url, x = {}) => ({ url, status: 200, contentType: 'text/html; charset=utf-8', redirectChain: [], title: 'Başlık', metaDescription: 'Açıklama', h1: ['Ana başlık'], metaRobots: '', canonical: url, inlinks: 1, ...x });
const crawl = (host, pages, meta = {}) => ({ meta: { host, startUrl: `https://${host}/`, startedAt: '2026-10-10T10:00:00Z', ...meta }, pages });
const O = (p, x) => page('https://www.ornek.com' + p, x);
const N = (p, x) => page('https://staging.ornek.com' + p, x);
const redirect = (p, to, finalStatus = 200) => N(p, { status: 301, finalStatus, finalUrl: 'https://staging.ornek.com' + to, redirectChain: [{ url: 'https://staging.ornek.com' + p, status: 301 }] });

const oldRes = crawl('www.ornek.com', [
  O('/'), O('/hakkimizda'), O('/urunler/a'), O('/urunler/b', { title: 'Eski B' }),
  O('/blog/yazi', { inlinks: 9 }), O('/iletisim/'), O('/eski-kampanya', { inlinks: 30 }), O('/silinen'),
  O('/gizli'), O('/noindex-olacak'), O('/yonlenen-kirik'), O('/%C5%9Fehir'),
  O('/eski-redirect', { status: 301, redirectChain: [{ status: 301 }] }), // old redirects are not old pages
]);
const newRes = crawl('staging.ornek.com', [
  N('/'), N('/hakkimizda'), N('/urunler/a', { title: '' }), N('/urunler/b', { title: 'Yeni B' }),
  redirect('/blog/yazi', '/blog/yeni-yazi'), N('/blog/yeni-yazi'), N('/iletisim'), N('/silinen', { status: 404 }),
  N('/gizli', { status: 0, blockedByRobots: true }), N('/noindex-olacak', { metaRobots: 'noindex, follow' }),
  redirect('/yonlenen-kirik', '/yok', 404), N('/%C5%9Fehir'), N('/yeni-sayfa'),
]);
const cmp = compareCrawls(oldRes, newRes);
const paths = (list) => list.map((r) => r.path).sort();

await check('yol anahtarı: sondaki / ve Türkçe karakter', () => {
  assert.equal(pathKey('https://a.com/iletisim/'), '/iletisim');
  assert.equal(pathKey('https://b.com/iletisim'), '/iletisim');
  assert.equal(pathKey('https://a.com/'), '/');
  assert.equal(pathKey('https://a.com/%C5%9Fehir?x=1'), '/şehir?x=1');
});
await check('farklı hostlar yol ile eşleşir', () => assert.equal(cmp.summary.oldPages, 12));
await check('yoklama öncesi: bulunamayan sayfa yoklanacak diye işaretli', () => {
  assert.equal(cmp.rows.lost.find((r) => r.path === '/eski-kampanya').probe, true);
  assert.equal(cmp.rows.lost.find((r) => r.path === '/silinen').probe, undefined);
});
await check('kaybolan: yeni sitede yok veya 4xx', () => {
  assert.deepEqual(paths(cmp.rows.lost), ['/eski-kampanya', '/silinen']);
  assert.equal(cmp.rows.lost.find((r) => r.path === '/silinen').newStatus, 404);
});
await check('kaybolanlar önem sırasına göre gelir', () => assert.equal(cmp.rows.lost[0].path, '/eski-kampanya'));
await check('yönlenen sayfa ve hatalı hedef', () => {
  assert.deepEqual(paths(cmp.rows.redirected), ['/blog/yazi', '/yonlenen-kirik']);
  assert.equal(cmp.rows.redirected.find((r) => r.path === '/yonlenen-kirik').targetBroken, true);
  assert.equal(cmp.rows.redirected.find((r) => r.path === '/blog/yazi').targetBroken, false);
  assert.equal(cmp.summary.redirectBroken, 1);
});
await check('içerik kaybı: boş title ve eklenen noindex', () => {
  const a = cmp.rows.changed.find((r) => r.path === '/urunler/a');
  assert.deepEqual(a.changes.map((c) => [c.field, c.kind]), [['title', 'lost']]);
  const n = cmp.rows.changed.find((r) => r.path === '/noindex-olacak');
  assert.deepEqual(n.changes.map((c) => [c.field, c.kind]), [['noindex', 'lost']]);
  assert.equal(cmp.summary.contentLost, 2);
});
await check('içerik değişimi: farklı title kayıp sayılmaz', () => {
  const b = cmp.rows.changed.find((r) => r.path === '/urunler/b');
  assert.deepEqual(b.changes, [{ field: 'title', label: 'Title', kind: 'changed', old: 'Eski B', new: 'Yeni B' }]);
});
await check('kayıplı sayfalar listenin başında', () => assert.ok(cmp.rows.changed[0].lostCount > 0));
await check('aynı kalan sayfalar sayılır', () => assert.equal(cmp.summary.same, 4)); // /, /hakkimizda, /iletisim, /şehir
await check('robots engeli "kaybolan" sayılmaz', () => {
  assert.deepEqual(paths(cmp.rows.unknown), ['/gizli']);
  assert.ok(cmp.warnings.some((w) => w.includes('robots')));
});
await check('yeni sayfalar: yönlendirme hedefi dahil', () => assert.deepEqual(paths(cmp.rows.added), ['/blog/yeni-yazi', '/yeni-sayfa']));
await check('korunan oran', () => assert.equal(cmp.summary.kept, Math.round((4 + 3) / 12 * 100)));
await check('URL limiti uyarısı', () => {
  const c = compareCrawls(oldRes, { ...newRes, meta: { ...newRes.meta, limitReached: true } });
  assert.ok(c.warnings.some((w) => w.includes('limit')));
});
await check('aynı tarama ile karşılaştırma: kayıp yok', () => {
  const c = compareCrawls(oldRes, oldRes);
  assert.deepEqual([c.summary.lost, c.summary.changed, c.summary.added], [0, 0, 0]);
});

// ---------- Probe: old paths requested on the new host ----------
const PROBE_OLD = crawl('www.ornek.com', ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'].map((p) => O(p)));
const PROBE_NEW = crawl('staging.ornek.com', [N('/')]);
const fake = {
  '/a': { status: 301, location: '/a-yeni' }, '/a-yeni': { status: 200 },
  '/b': { status: 302, location: 'https://staging.ornek.com/b2' }, '/b2': { status: 301, location: '/b3' }, '/b3': { status: 200 },
  '/c': { status: 301, location: '/yok' }, '/yok': { status: 404 },
  '/d': { status: 200 }, '/e': { status: 410 }, '/f': { status: 401 },
  '/g': 'ECONNRESET',
  '/h': { status: 301, location: '/h' }, // loop
};
const seen = [];
const request = async (url) => {
  const p = new URL(url).pathname; seen.push(url);
  const x = fake[p];
  if (typeof x === 'string') throw Object.assign(new Error(x), { cause: { code: x } });
  return x || { status: 404 };
};
const pc = await probeLost(compareCrawls(PROBE_OLD, PROBE_NEW), 'https://staging.ornek.com', request, { concurrency: 3 });
const find = (list, p) => pc.rows[list].find((r) => r.path === p);

await check('yoklama: istekler yeni hosta gider', () => assert.ok(seen.every((u) => u.startsWith('https://staging.ornek.com/'))));
await check('yoklama: 301 ile yönlenen eski URL "yönleniyor" olur', () => {
  const a = find('redirected', '/a');
  assert.deepEqual([a.status, a.finalStatus, a.hops, a.targetBroken, a.target], [301, 200, 1, false, 'https://staging.ornek.com/a-yeni']);
});
await check('yoklama: zincir adımları sayılır', () => assert.deepEqual([find('redirected', '/b').status, find('redirected', '/b').hops], [302, 2]));
await check('yoklama: 404 hedefe yönlenen URL hatalı sayılır', () => assert.equal(find('redirected', '/c').targetBroken, true));
await check('yoklama: açılan ama linksiz sayfa kaybolmuş sayılmaz', () => assert.ok(find('unlinked', '/d')));
await check('yoklama: 410 kaybolan kalır, status yazılır', () => assert.equal(find('lost', '/e').newStatus, 410));
await check('yoklama: 401 ve bağlantı hatası "kontrol edilemedi" olur', () => {
  assert.match(find('unknown', '/f').reason, /401/);
  assert.match(find('unknown', '/g').reason, /ECONNRESET/);
  assert.ok(pc.warnings.some((w) => w.includes('kontrol edilemedi')));
});
await check('yoklama: yönlendirme döngüsü sonsuz sürmez', () => assert.equal(find('redirected', '/h').hops, 6));
await check('yoklama: özet yeniden hesaplanır', () => {
  assert.deepEqual([pc.summary.lost, pc.summary.redirected, pc.summary.unlinked, pc.summary.unknown, pc.probed], [1, 4, 1, 2, 8]);
  assert.equal(pc.summary.kept, Math.round(1 / 8 * 100));
});

await check('Excel: sayfalar ve satırlar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cmp-'));
  const f = path.join(dir, 'c.xlsx');
  await exportCompareExcel(cmp, f);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Özet', 'Kaybolan', 'Yönlenen', 'İçerik değişimi', 'Kontrol edilemedi', 'Yeni sayfalar']);
  assert.equal(wb.getWorksheet('Kaybolan').rowCount, 3);
  await rm(dir, { recursive: true, force: true });
});

console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
