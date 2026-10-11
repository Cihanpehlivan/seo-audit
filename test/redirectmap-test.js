// Tests for the 301 map (v0.8.0): words, scores, confidence, decisions, CSV. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareCrawls, probeLost } from '../src/compare.js';
import { words, suggestTargets, buildRedirectMap, mapCsv, cleanDecision } from '../src/redirectmap.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('301 haritası testi');

const cfg = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url))).redirectMap;
const page = (url, title, x = {}) => ({ url, status: 200, contentType: 'text/html; charset=utf-8', redirectChain: [], title, metaDescription: 'x', h1: [title], metaRobots: '', canonical: url, inlinks: 1, ...x });
const crawl = (host, pages) => ({ meta: { host, startUrl: `https://${host}/`, startedAt: '2026-10-11T10:00:00Z' }, pages });
const O = (p, t, x) => page('https://www.eski.com' + p, t, x);
const N = (p, t, x) => page('https://staging.ornek.com' + p, t, x);
const T = (p, t, x) => page('https://tr.ornek.com' + p, t, x);

// Old site: procedures under /prosedur/ (English slugs), a Turkish blog post, a French page.
// New site: procedures under /procedures/ with shorter slugs. French is gone.
const OLD = crawl('www.eski.com', [
  O('/', 'Ana sayfa'), O('/hakkimizda', 'Hakkımızda'),
  O('/prosedur/rhinoplasty-istanbul', 'Rhinoplasty in Istanbul'), O('/prosedur/facelift-turkey', 'Facelift in Turkey'),
  O('/prosedur/eyelid-surgery', 'Eyelid Surgery Istanbul'), O('/prosedur/breast-augmentation', 'Breast Augmentation'),
  O('/blog/kis-cilt-bakimi', 'Kışın cilt bakımı nasıl yapılır?'), O('/fr/a-propos', 'À propos'),
]);
const NEW = crawl('staging.ornek.com', [
  N('/', 'Ana sayfa'), N('/hakkimizda', 'Hakkımızda'), N('/iletisim', 'İletişim'),
  N('/procedures/rhinoplasty', 'Rhinoplasty | Clinic'), N('/procedures/revision-rhinoplasty', 'Revision rhinoplasty'),
  N('/procedures/facelift', 'Facelift'), N('/procedures/blepharoplasty', 'Blepharoplasty (eyelid surgery)'),
  N('/procedures/breast-augmentation-surgery', 'Breast augmentation surgery'), N('/blog/kis-aylarinda-cilt-bakimi', 'Kış aylarında cilt bakımı'),
  N('/gizli', 'Breast augmentation surgery', { metaRobots: 'noindex' }),
]);
const SITES = [{ key: 'heir', host: 'staging.ornek.com', origin: 'https://staging.ornek.com', liveOrigin: 'https://www.eski.com', pages: NEW.pages }];
const cmp = compareCrawls(OLD, [NEW]);
const map = buildRedirectMap(cmp, OLD, SITES, {}, cfg);
const row = (p, m = map) => m.rows.find((r) => r.path === p);

await check('kelimeler: Türkçe harfler ve aksanlar sadeleşir, sayı ve durak kelimesi çıkar', () => {
  assert.deepEqual(words('Kışın Cilt Bakımı NASIL yapılır? 2024', new Set(cfg.stopWords)), ['kisin', 'cilt', 'bakimi', 'yapilir']);
  assert.deepEqual(words('À propos — Göğüs İçin'), ['propos', 'gogus', 'icin']);
});
await check('öneri: slug değişince doğru sayfa bulunur', () => {
  assert.equal(row('/prosedur/rhinoplasty-istanbul').target.path, '/procedures/rhinoplasty');
  assert.equal(row('/prosedur/facelift-turkey').target.path, '/procedures/facelift');
  assert.equal(row('/prosedur/breast-augmentation').target.path, '/procedures/breast-augmentation-surgery');
  assert.equal(row('/blog/kis-cilt-bakimi').target.path, '/blog/kis-aylarinda-cilt-bakimi'); // ı → i, ş → s
});
await check('öneri: başka dilde slug, title ile bulunur (eyelid → blepharoplasty)', () => {
  const r = row('/prosedur/eyelid-surgery');
  assert.equal(r.target.path, '/procedures/blepharoplasty');
  assert.match(r.why, /Title %\d+ benzer/);
});
await check('öneri: aday sırası ve gerekçe', () => {
  const r = row('/prosedur/rhinoplasty-istanbul');
  assert.deepEqual(r.candidates.slice(0, 2).map((c) => c.path), ['/procedures/rhinoplasty', '/procedures/revision-rhinoplasty']);
  assert.match(r.why, /Slug ortak: rhinoplasty/);
  assert.doesNotMatch(r.why, /Slug ortak: [^·]*prosedur/); // the section word is not a reason
  assert.match(r.why, /Aynı bölüm \(\/prosedur\/ → \/procedures\/\)/);
});
await check('güven: puan eşiklere göre Yüksek / Orta / Düşük olur', () => {
  for (const r of map.rows.filter((x) => x.status === 'pending')) {
    const want = r.score >= cfg.high ? 'high' : r.score >= cfg.mid ? 'mid' : 'low';
    assert.equal(r.conf, want, r.path);
  }
  assert.equal(row('/prosedur/breast-augmentation').conf, 'high');
  assert.equal(map.summary.high, map.rows.filter((r) => r.status === 'pending' && r.conf === 'high').length);
});
await check('öneri yok: benzer sayfa yoksa ana sayfa önerilmez', () => {
  const r = row('/fr/a-propos');
  assert.deepEqual([r.status, r.target, r.candidates.length], ['none', null, 0]);
  assert.match(r.why, /soft 404/);
  assert.ok(map.rows.every((x) => (x.candidates || []).every((c) => c.path !== '/')), 'ana sayfa aday olmaz');
  assert.ok(map.rows.every((x) => (x.candidates || []).every((c) => c.path !== '/gizli')), 'noindex sayfa aday olmaz');
});
await check('adres: yeni URL canlı alan adı ile yazılır', () => {
  assert.equal(row('/prosedur/facelift-turkey').target.url, 'https://www.eski.com/procedures/facelift');
});
await check('karar: onay, elle adres, 410 ve uyarı', () => {
  const m = buildRedirectMap(cmp, OLD, SITES, {
    '/prosedur/eyelid-surgery': { site: 'heir', path: '/procedures/blepharoplasty', src: 'oneri' },
    '/fr/a-propos': { gone: true },
    '/blog/kis-cilt-bakimi': { site: 'heir', path: '/blog/yok', src: 'elle' },
    '/prosedur/facelift-turkey': { url: 'https://partner.example/facelift', src: 'elle' },
    '/silinmis': { gone: true },
  }, cfg);
  assert.deepEqual([row('/prosedur/eyelid-surgery', m).status, row('/prosedur/eyelid-surgery', m).warn], ['approved', '']);
  assert.equal(row('/fr/a-propos', m).status, 'gone');
  assert.match(row('/blog/kis-cilt-bakimi', m).warn, /son taramada yok/);
  assert.equal(row('/prosedur/facelift-turkey', m).target.url, 'https://partner.example/facelift');
  assert.deepEqual([m.summary.approved, m.summary.gone, m.summary.warn, m.summary.stale], [3, 1, 1, 1]);
  // Order: pending first, then none, approved, gone.
  assert.equal(m.rows[m.rows.length - 1].status, 'gone');
});
await check('CSV: sadece kural, onay ve 410 satırları; formül koruması', () => {
  const m = buildRedirectMap(cmp, OLD, SITES, { '/prosedur/eyelid-surgery': { site: 'heir', path: '/procedures/blepharoplasty' }, '/fr/a-propos': { gone: true } }, cfg);
  const csv = mapCsv(m);
  assert.ok(csv.startsWith('\ufeffeski_url,yeni_url,durum,kaynak\r\n'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.includes('https://www.eski.com/prosedur/eyelid-surgery,https://www.eski.com/procedures/blepharoplasty,301,Onay'));
  assert.ok(lines.includes('https://www.eski.com/fr/a-propos,,410,Onay'));
  const evil = { rows: [{ status: 'approved', oldUrl: '=HYPERLINK("x")', target: { url: 'https://a.test/b' }, decision: { src: 'elle' } }] };
  assert.match(mapCsv(evil), /"'=HYPERLINK\(""x""\)",https:\/\/a\.test\/b,301,Elle/);
});
await check('kural satırı: bölüm kuralı ile taşınan sayfa haritaya kendiliğinden girer', async () => {
  const old = crawl('www.eski.com', [O('/', 'Ana'), O('/tr/hakkimizda', 'Hakkımızda'), O('/tr/iletisim', 'İletişim'), O('/tr/burun-estetigi-nedir', 'Burun estetiği nedir?')]);
  const tr = crawl('tr.ornek.com', [T('/', 'Ana'), T('/hakkimizda', 'Hakkımızda'), T('/iletisim', 'İletişim'), T('/burun-estetigi', 'Burun estetiği'), T('/yuz-germe', 'Yüz germe')]);
  const heir = crawl('staging.ornek.com', [N('/', 'Ana'), N('/about', 'Hakkımızda')]);
  const c = compareCrawls(old, [heir, tr], { rules: [{ from: '/tr/*', host: 'tr.ornek.com', to: '/*' }] });
  await probeLost(c, async () => ({ status: 404, location: null, contentType: 'text/html' })); // no 301 on the heir yet
  const sites = [SITES[0] && { ...SITES[0], pages: heir.pages }, { key: 'tr', host: 'tr.ornek.com', origin: 'https://tr.ornek.com', liveOrigin: 'https://tr.eski.com', pages: tr.pages }];
  const m = buildRedirectMap(c, old, sites, {}, cfg);
  const k = row('/tr/hakkimizda', m);
  assert.deepEqual([k.status, k.kind, k.target.url, k.installed], ['rule', 'rule', 'https://tr.eski.com/hakkimizda', false]);
  // Rule to a site, target missing: the suggestion stays on that site (not the English heir /about).
  const s = row('/tr/burun-estetigi-nedir', m);
  assert.deepEqual([s.status, s.target.site, s.target.path], ['pending', 'tr', '/burun-estetigi']);
  assert.equal(m.summary.rule, 2);
});
await check('karar temizliği: geçersiz kararlar düşer', () => {
  const keys = new Set(['heir', 'tr']);
  assert.deepEqual(cleanDecision({ site: 'tr', path: '/a/b/' }, keys), { site: 'tr', path: '/a/b', src: 'oneri' });
  assert.equal(cleanDecision({ site: 'yok', path: '/a' }, keys), null);
  assert.equal(cleanDecision({ url: 'javascript:alert(1)' }, keys), null);
  assert.deepEqual(cleanDecision({ url: 'https://x.test/a', src: 'elle' }, keys), { url: 'https://x.test/a', src: 'elle' });
  assert.deepEqual(cleanDecision({ gone: 1 }, keys), { gone: true, src: 'oneri' });
});
await check('hız: 3.000 eski sayfa × 3.000 yeni sayfa', () => {
  const topics = Array.from({ length: 3000 }, (_, i) => `konu${i.toString(36)} baslik${(i * 7).toString(36)}`);
  const olds = topics.map((t, i) => ({ path: `/eski/${t.replace(' ', '-')}-yazisi`, title: `${t} yazısı`, h1: t, simhash: null, prefer: null }));
  const pages = topics.map((t) => N(`/yeni/${t.replace(' ', '-')}`, t));
  const t0 = Date.now();
  const out = suggestTargets(olds, [{ ...SITES[0], pages }], cfg);
  const ms = Date.now() - t0;
  assert.equal(out.get(olds[42].path)[0].path, pages[42].url.replace('https://staging.ornek.com', ''));
  assert.ok(ms < 5000, `${ms} ms`);
  console.log(`    (${ms} ms)`);
});

console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
