// Tests for the old site vs new site comparison (Sprint 3, part 1). No network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { compareCrawls, pathKey, probeLost, parseRule, parseRules } from '../src/compare.js';
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
const pc = await probeLost(compareCrawls(PROBE_OLD, PROBE_NEW), request, { concurrency: 3 });
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
await check('açıklama: yönlendirme zinciri ve 302 için yapılacak yazılır', () => {
  assert.match(find('redirected', '/b').todo, /Zincir 2 adım/);
  assert.equal(find('redirected', '/a').todo, '');
  assert.match(find('redirected', '/c').todo, /Hedef 404/);
  assert.match(find('unknown', '/f').todo, /şifre/);
  assert.equal(find('lost', '/e').checkUrl, 'https://staging.ornek.com/e');
});
await check('yoklama: yönlendirme döngüsü sonsuz sürmez', () => assert.equal(find('redirected', '/h').hops, 6));
await check('yoklama: özet yeniden hesaplanır', () => {
  assert.deepEqual([pc.summary.lost, pc.summary.redirected, pc.summary.unlinked, pc.summary.unknown, pc.probed], [1, 4, 1, 2, 8]);
  assert.equal(pc.summary.kept, Math.round(1 / 8 * 100));
});

// ---------- v0.6.1: path rules, many targets, pattern suggestions, explanations ----------
// Old site: English at the root, Turkish under /tr/, French under /fr/.
// New sites: English without a prefix (main target), Turkish on its own domain. French is gone.
const E = (p, x) => page('https://www.eski.com' + p, x);
const EN = (p, x) => page('https://staging.ornek.com' + p, x);
const TR = (p, x) => page('https://tr.ornek.com' + p, x);
const ML_OLD = crawl('www.eski.com', [
  ...['/', '/about', '/services', '/services/a', '/contact'].map((p) => E(p)),
  ...['/tr', '/tr/hakkimizda', '/tr/hizmetler', '/tr/hizmetler/a', '/tr/iletisim'].map((p) => E(p)),
  ...['/fr', '/fr/a-propos', '/fr/prestations', '/fr/nous-contacter'].map((p) => E(p)),
]);
const ML_EN = crawl('staging.ornek.com', ['/', '/about', '/services', '/services/a', '/contact'].map((p) => EN(p)));
const ML_TR = crawl('tr.ornek.com', ['/', '/hakkimizda', '/hizmetler', '/hizmetler/a', '/blog'].map((p) => TR(p)));
const ML_RULES = [{ from: '/tr/*', host: 'tr.ornek.com', to: '/*' }, { from: '/fr/', drop: true }];

await check('kural: "/tr/" "/tr/*" olur, yanlış yazım açık hata verir', () => {
  assert.equal(parseRule({ from: '/tr/', to: '/' }).from, '/tr/*');
  assert.equal(parseRule({ from: '/fr/*', drop: true }).text, '/fr/* → bölüm kaldırıldı');
  assert.equal(parseRule({ from: '/en/*', to: '/*' }).text, '/en/* → geçecek site /*');
  assert.equal(parseRule({ from: '/tr/*', host: 'https://www.TR.ornek.com/x', to: '/*' }).host, 'tr.ornek.com');
  assert.throws(() => parseRule({ from: 'tr/*' }), /"\/" ile başlamalı/);
  assert.throws(() => parseRule({ from: '/tr/*/a' }), /sadece sonda/);
  assert.throws(() => parseRules([{ from: '/a/*' }, { from: 'b' }]), /^Error: Kural 2:/);
  assert.throws(() => parseRules(new Array(3).fill({ from: '/a' }), 2), /En fazla 2/);
});
await check('kural: en uzun eski yol önce gelir', () => {
  const r = parseRules([{ from: '/*', to: '/en/*' }, { from: '/tr/*' }, { from: '/tr/blog/*' }, { from: '/tr' }]);
  assert.deepEqual(r.map((x) => x.from), ['/tr/blog/*', '/tr', '/tr/*', '/*']);
});
await check('kural: yol taşıma, sorgu ve benzer önek', () => {
  const c = compareCrawls(
    crawl('www.eski.com', [E('/tr'), E('/tr/a/b'), E('/trabzon'), E('/tr?x=1'), E('/fr/x'), E('/fr/y')]),
    crawl('staging.ornek.com', [EN('/'), EN('/a/b'), EN('/trabzon'), EN('/?x=1')]),
    { rules: [{ from: '/tr/*', to: '/*' }, { from: '/fr/*', to: '/yok' }] },
  );
  // Moved paths are not "same": the old URL must 301. Only /trabzon (no rule) stays on its path.
  assert.equal(c.summary.same, 1);
  const np = (p) => c.rows.moving.find((r) => r.path === p).newPath;
  assert.deepEqual([np('/tr'), np('/tr/a/b'), np('/tr?x=1')], ['/', '/a/b', '/?x=1']);
  assert.equal(c.rows.moving.find((r) => r.path === '/tr').rule, '/tr/* → staging.ornek.com/*');
  assert.deepEqual(c.rows.moving.filter((r) => r.newPath === '/yok').length, 2); // many old pages → one path (no "*" in target)
  assert.equal(c.summary.pending, 5);
});
await check('çoklu hedef: kuralsız yol ana hedefe, kurallı yol kendi sitesine gider', () => {
  const c = compareCrawls(ML_OLD, [ML_EN, ML_TR], { rules: ML_RULES });
  assert.deepEqual(c.targets.map((t) => t.host), ['staging.ornek.com', 'tr.ornek.com']);
  assert.equal(c.summary.same, 5); // 5 English. Turkish pages moved: they wait for the 301 check.
  const mv = c.rows.moving.find((r) => r.path === '/tr/iletisim');
  assert.deepEqual([mv.site, mv.newPath, mv.checkUrl, mv.heirUrl, mv.rule], ['tr.ornek.com', '/iletisim', 'https://tr.ornek.com/iletisim', 'https://staging.ornek.com/tr/iletisim', '/tr/* → tr.ornek.com/*']);
  assert.deepEqual(c.rows.added.map((r) => [r.site, r.path]), [['tr.ornek.com', '/blog']]);
});
const mlSeen = [];
const mlRequest = async (url) => {
  mlSeen.push(url);
  return new URL(url).pathname === '/fr/a-propos' ? { status: 301, location: '/about' } : new URL(url).pathname === '/about' ? { status: 200 } : { status: 404 };
};
const ml = await probeLost(compareCrawls(ML_OLD, [ML_EN, ML_TR], { rules: ML_RULES }), mlRequest);
await check('yoklama: her sayfa kuralın hedefinde istenir', () => {
  assert.ok(mlSeen.includes('https://tr.ornek.com/iletisim')); // target page
  assert.ok(mlSeen.includes('https://staging.ornek.com/tr/iletisim')); // 301 check on the heir
  assert.ok(mlSeen.includes('https://staging.ornek.com/fr/prestations'));
  assert.ok(!mlSeen.includes('https://tr.ornek.com/hakkimizda')); // target is in the crawl: no request
});
await check('bölüm kaldırıldı: bulunmayan sayfa "Kayboldu" grubuna girmez', () => {
  assert.deepEqual(ml.rows.removed.map((r) => r.path).sort(), ['/fr', '/fr/nous-contacter', '/fr/prestations']);
  assert.deepEqual(ml.rows.lost, []);
  assert.deepEqual(ml.rows.notarget.map((r) => r.path), ['/tr/iletisim']);
  assert.equal(ml.rows.no301.length, 4); // the heir answers 404 for the old Turkish paths
  assert.equal(ml.rows.redirected.find((r) => r.path === '/fr/a-propos').target, 'https://staging.ornek.com/about');
  assert.match(ml.rows.removed[0].todo, /410/);
  assert.equal(ml.summary.removed, 3);
});
await check('kural istatistiği: sayfa ve bulunan sayısı', () => {
  const st = Object.fromEntries(ml.rules.map((r) => [r.from, [r.pages, r.found]]));
  assert.deepEqual(st, { '/tr/*': [5, 4], '/fr/*': [4, 1] });
  assert.deepEqual([ml.noRule.pages, ml.noRule.found], [5, 5]);
});
await check('öneri: kuralsız çoklu hedefte /tr/* → tr sitesi, /fr/* bulunamadı (kaldırıldı önerilmez)', () => {
  const c = compareCrawls(ML_OLD, [ML_EN, ML_TR]);
  const tr = c.suggestions.find((x) => x.from === '/tr/*');
  assert.deepEqual([tr.host, tr.to, tr.hits, tr.total], ['tr.ornek.com', '/*', 4, 5]);
  assert.match(tr.why, /\/tr\/ altındaki 5 sayfanın 4 tanesi tr\.ornek\.com taramasında \/tr\/ öneki olmadan var/);
  const fr = c.suggestions.find((x) => x.from === '/fr/*');
  assert.deepEqual([fr.notFound, fr.drop, fr.hits, fr.host], [true, undefined, 0, undefined]);
  assert.match(fr.why, /Adresler \(slug\) değişmiş olabilir/);
  assert.ok(!c.suggestions.some((x) => x.drop), 'bölüm kaldırıldı hiç önerilmez');
  assert.equal(c.suggestions.length, 2); // the English root needs no rule
});
await check('öneri: slug değişince az sayfa bulan taşıma sadece ipucu olur, uygulanmaz', () => {
  // Old /tr/ has 6 pages. The Turkish site keeps 2 of them without the prefix; 4 slugs changed.
  const old = crawl('www.eski.com', ['/', '/tr', '/tr/a', '/tr/b', '/tr/eski-c', '/tr/eski-d', '/tr/eski-e'].map((p) => E(p)));
  const tr = crawl('tr.ornek.com', ['/', '/a', '/yeni-c', '/yeni-d', '/yeni-e'].map((p) => TR(p)));
  const c = compareCrawls(old, [crawl('staging.ornek.com', [EN('/')]), tr]);
  const s = c.suggestions.find((x) => x.from === '/tr/*');
  assert.deepEqual([s.notFound, s.host, s.to, s.hits, s.total], [true, 'tr.ornek.com', '/*', 2, 6]);
  assert.match(s.why, /6 sayfanın sadece 2 tanesi tr\.ornek\.com taramasında var\. Diğer adresler değişmiş olabilir/);
});
await check('öneri: eklenen kural tekrar önerilmez', () => {
  const c = compareCrawls(ML_OLD, [ML_EN, ML_TR], { rules: ML_RULES });
  assert.deepEqual(c.suggestions, []);
});
await check('öneri: /en/* öneki ana hedefte kaldırılır', () => {
  const c = compareCrawls(crawl('www.eski.com', ['/en', '/en/a', '/en/b', '/en/c'].map((p) => E(p))), crawl('staging.ornek.com', ['/', '/a', '/b', '/c'].map((p) => EN(p))));
  assert.deepEqual(c.suggestions.map((x) => [x.from, x.host, x.to, x.hits]), [['/en/*', '', '/*', 4]]);
});
await check('kural hedefi seçilmediyse sayfa "Kontrol edilemedi" olur ve çözüm yazılır', () => {
  const c = compareCrawls(ML_OLD, [ML_EN], { rules: ML_RULES });
  const r = c.rows.unknown.find((x) => x.path === '/tr/hakkimizda');
  assert.match(r.reason, /tr\.ornek\.com/);
  assert.match(r.todo, /tr\.ornek\.com sitesini tarayın/);
  assert.ok(c.warnings.some((w) => w.includes('tr.ornek.com taranmadı')));
});
// ---------- v0.7.0: moved pages need a target page and a 301 on the heir ----------
// Heir = the site that takes the old domain (staging.ornek.com). Turkish moves to tr.ornek.com (live: tr.eski.com).
const MV_OLD = crawl('www.eski.com', ['/', '/about', '/en/team', '/tr/a', '/tr/b', '/tr/c', '/tr/d', '/tr/e', '/tr/f', '/tr/g'].map((p) => E(p)));
const MV_EN = crawl('staging.ornek.com', [EN('/'), EN('/about'), EN('/team', { title: '' }),
  EN('/tr/a', { status: 301, finalStatus: 200, finalUrl: 'https://tr.ornek.com/a', redirectChain: [{ url: 'https://staging.ornek.com/tr/a', status: 301, to: 'https://tr.ornek.com/a' }] })]);
const MV_TR = crawl('tr.ornek.com', ['/a', '/b', '/c', '/d', '/e', '/g'].map((p) => TR(p)));
const MV_RULES = [{ from: '/tr/*', host: 'tr.ornek.com', to: '/*' }, { from: '/en/*', to: '/*' }];
const MV_OPTS = { rules: MV_RULES, live: { 'tr.ornek.com': 'tr.eski.com' } };
const H = 'https://staging.ornek.com';
const mvFake = {
  [H + '/en/team']: { status: 301, location: 'https://www.eski.com/team' }, // heir live host = old domain
  [H + '/tr/b']: { status: 301, location: 'https://tr.eski.com/b' }, // live host of the target
  [H + '/tr/c']: { status: 200 },
  [H + '/tr/d']: { status: 301, location: '/tr/d2' }, [H + '/tr/d2']: { status: 301, location: 'https://tr.ornek.com/d' },
  [H + '/tr/e']: { status: 301, location: 'https://baska.com/e' },
  [H + '/tr/g']: { status: 302, location: 'https://tr.ornek.com/x' },
  'https://tr.ornek.com/f': { status: 404 },
};
const mvSeen = [];
const mvRequest = async (url) => { mvSeen.push(url); return mvFake[url] || { status: 404 }; };
const mvPre = compareCrawls(MV_OLD, [MV_EN, MV_TR], MV_OPTS);
const mv = await probeLost(compareCrawls(MV_OLD, [MV_EN, MV_TR], MV_OPTS), mvRequest);
const mvRow = (p) => ['moved', 'no301', 'notarget', 'unknown'].map((k) => [k, mv.rows[k].find((r) => r.path === p)]).find(([, r]) => r);

await check('taşıma: hedef sayfa var diye "Aynı kaldı" sayılmaz', () => {
  assert.equal(mvPre.summary.same, 2);
  assert.equal(mvPre.summary.pending, 7); // /tr/a is decided from the heir crawl
  assert.equal(mvPre.rows.moved.find((r) => r.path === '/tr/a').reason, 'Hedef hazır, 301 kurulu');
});
await check('taşıma: istekler sadece taranan sitelere gider', () => {
  assert.ok(mvSeen.every((u) => u.startsWith(H) || u.startsWith('https://tr.ornek.com/')));
  assert.ok(!mvSeen.includes(H + '/tr/a') && !mvSeen.includes('https://tr.ornek.com/b'));
});
await check('taşıma: 301 kurulu (staging, canlı alan adı ve eski alan adı)', () => {
  for (const p of ['/tr/a', '/tr/b', '/en/team']) assert.equal(mvRow(p)[0], 'moved', p);
  assert.equal(mvRow('/tr/b')[1].target, 'https://tr.eski.com/b');
});
await check('taşıma: zincir 301 kurulu sayılır, yapılacak yazılır', () => {
  const [k, r] = mvRow('/tr/d');
  assert.equal(k, 'moved'); assert.equal(r.hops, 2); assert.match(r.todo, /Zincir 2 adım/);
});
await check('taşıma: hedef sayfada içerik kaybı yazılır', () => {
  const [k, r] = mvRow('/en/team');
  assert.equal(k, 'moved'); assert.equal(r.lostCount, 1); assert.match(r.todo, /Title/);
  assert.equal(mv.summary.contentLost, 1);
});
await check('taşıma: 301 eksik (açılıyor, başka sayfa, bilinmeyen alan adı, 302)', () => {
  const c = mvRow('/tr/c'), e = mvRow('/tr/e'), g = mvRow('/tr/g');
  assert.deepEqual([c[0], e[0], g[0]], ['no301', 'no301', 'no301']);
  assert.match(c[1].reason, /yönlenmiyor \(200\)/);
  assert.equal(c[1].todo, 'Eski alan adına geçecek sitede 301 kurun: /tr/c → https://tr.eski.com/c');
  assert.match(e[1].reason, /baska\.com alan adına gidiyor/);
  assert.match(e[1].todo, /canlı alan adını projeye yazın/);
  assert.match(g[1].todo, /https:\/\/tr\.eski\.com\/g adresine değiştirin/);
});
await check('taşıma: hedef yok', () => {
  const [k, r] = mvRow('/tr/f');
  assert.equal(k, 'notarget'); assert.equal(r.newStatus, 404); assert.match(r.todo, /oluşturun/);
});
await check('taşıma: özet, korunan oran ve kural istatistiği', () => {
  const s = mv.summary;
  assert.deepEqual([s.moved, s.moveFix, s.no301, s.notarget, s.pending, s.same], [4, 2, 3, 1, 0, 2]);
  assert.equal(s.kept, Math.round(6 / 10 * 100));
  const st = Object.fromEntries(mv.rules.map((r) => [r.from, [r.pages, r.found]]));
  assert.deepEqual(st['/tr/*'], [7, 6]); // 301 eksik olan sayfanın hedefi bulundu sayılır
});
await check('taşıma: 401 veren geçecek site "Kontrol edilemedi" olur', async () => {
  const c = await probeLost(compareCrawls(MV_OLD, [MV_EN, MV_TR], MV_OPTS), async (u) => (u.startsWith(H) ? { status: 401 } : { status: 200 }));
  const r = c.rows.unknown.find((x) => x.path === '/tr/c');
  assert.match(r.reason, /Hedef hazır/); assert.match(r.todo, /şifre/);
});
await check('Excel: taşınan sayfalar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cmp-'));
  const f = path.join(dir, 'c.xlsx');
  await exportCompareExcel(mv, f);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f);
  const ws = wb.getWorksheet('Taşınan');
  assert.ok(ws); assert.equal(ws.rowCount, 9); // header + 8 moved pages
  await rm(dir, { recursive: true, force: true });
});

await check('Excel: kurallar, bölüm kaldırıldı ve yapılacak sütunu', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cmp-'));
  const f = path.join(dir, 'c.xlsx');
  await exportCompareExcel(ml, f);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes('Bölüm kaldırıldı') && names.includes('Kurallar'));
  assert.ok(wb.getWorksheet('Kaybolan').getRow(1).values.includes('Yapılacak'));
  assert.equal(wb.getWorksheet('Kurallar').rowCount, 4); // header + 2 rules + "Kural yok"
  await rm(dir, { recursive: true, force: true });
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
