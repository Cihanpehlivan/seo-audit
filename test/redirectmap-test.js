// Tests for the 301 map (v0.8.0): words, scores, confidence, decisions, CSV. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareCrawls, probeLost, sectionTable } from '../src/compare.js';
import { mapSource } from '../src/export.js';
import { words, suggestTargets, buildRedirectMap, mapCsv, cleanDecision, isHomeLike } from '../src/redirectmap.js';

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
// v0.8.1: real-site test (11 Oct 2026). Old site: English at the root, Turkish under /tr/, French under /fr/.
// New: English heir, Turkish on its own site. The user sent /tr/ to the heir by mistake and removed /fr/.
const L = (lang) => ({ htmlLang: lang });
const ML_OLD = crawl('www.eski.com', [
  O('/', 'Klinik', L('en-US')), O('/prosedur/botox-2', 'Botox', L('en-US')), O('/prosedur/blepharoplasty', 'Blepharoplasty', L('en-US')),
  O('/tr/home', 'Klinik', L('tr-TR')), O('/tr/hakkimda', 'Hakkımda', L('tr-TR')), O('/tr/iletisim', 'İletişim', L('tr-TR')),
  O('/tr/prosedur/botoks', 'Botoks', L('tr-TR')), O('/tr/prosedur/blefaroplasti', 'Blefaroplasti', L('tr-TR')),
  O('/fr/page-daccueil', 'Accueil', L('fr-FR')), O('/fr/prosedur/blepharoplastie', 'Blépharoplastie', L('fr-FR')),
  O('/fr/prosedur/botox', 'Botox', L('fr-FR')), O('/fr/a-propos', 'À propos', L('fr-FR')),
]);
const ML_HEIR = crawl('staging.ornek.com', [
  N('/', 'Facial surgery clinic', L('en')), N('/about', 'About the doctor', L('en')), N('/contact', 'Contact', L('en')),
  N('/procedures/medical-aesthetics/botox', 'Botox in Istanbul', L('en')), N('/procedures/facial-aesthetics/blepharoplasty', 'Blepharoplasty | Eyelid surgery', L('en')),
]);
const ML_TR = crawl('tr.ornek.com', [
  T('/', 'Yüz estetiği kliniği', L('tr')), T('/hakkimda', 'Hakkımda', L('tr')), T('/iletisim', 'İletişim', L('tr')),
  T('/prosedurler/medikal-estetik/botoks', 'Botoks', L('tr')), T('/prosedurler/yuz-estetigi/blefaroplasti', 'Blefaroplasti | Göz kapağı estetiği', L('tr')),
]);
const ML_SITES = [{ key: 'heir', host: 'staging.ornek.com', origin: 'https://staging.ornek.com', liveOrigin: 'https://www.eski.com', pages: ML_HEIR.pages },
  { key: 'tr', host: 'tr.ornek.com', origin: 'https://tr.ornek.com', liveOrigin: 'https://tr.eski.com', pages: ML_TR.pages }];
const mlMatch = async (rules) => {
  const c = compareCrawls(ML_OLD, [ML_HEIR, ML_TR], { rules });
  await probeLost(c, async () => ({ status: 404, location: null, contentType: 'text/html' }));
  return c;
};
const WRONG = [{ from: '/tr/*', host: '', to: '/tr/*' }, { from: '/fr/*', drop: true }];

await check('dil: Türkçe sayfaya Türkçe site önerilir, bölüm kararı İngilizce siteye gitse bile', async () => {
  const m = buildRedirectMap(await mlMatch(WRONG), ML_OLD, ML_SITES, {}, cfg);
  for (const [from, to] of [['/tr/hakkimda', '/hakkimda'], ['/tr/iletisim', '/iletisim'], ['/tr/prosedur/botoks', '/prosedurler/medikal-estetik/botoks'],
    ['/tr/prosedur/blefaroplasti', '/prosedurler/yuz-estetigi/blefaroplasti']]) {
    const r = row(from, m);
    assert.deepEqual([r.target?.site, r.target?.path], ['tr', to], from);
    assert.ok(r.candidates.every((c) => c.site === 'tr'), `${from}: İngilizce aday yok`);
  }
  // English pages stay on the English site.
  assert.deepEqual([row('/prosedur/botox-2', m).target.site, row('/prosedur/botox-2', m).target.path], ['heir', '/procedures/medical-aesthetics/botox']);
});
await check('dil: kaldırılan Fransızca bölüm geçecek siteye gider, Türkçe siteye gitmez', async () => {
  const m = buildRedirectMap(await mlMatch(WRONG), ML_OLD, ML_SITES, {}, cfg);
  const r = row('/fr/prosedur/blepharoplastie', m);
  assert.deepEqual([r.target.site, r.target.path], ['heir', '/procedures/facial-aesthetics/blepharoplasty']);
  assert.equal(row('/fr/prosedur/botox', m).target.path, '/procedures/medical-aesthetics/botox');
  assert.ok(m.rows.filter((x) => x.path.startsWith('/fr/')).every((x) => (x.candidates || []).every((c) => c.site === 'heir')));
  // No language on any page: a removed section goes to the heir too.
  const strip = (res) => ({ ...res, pages: res.pages.map(({ htmlLang, ...p }) => p) });
  const one = { path: '/fr/prosedur/blepharoplastie', title: 'Blepharoplastie blefaroplasti', h1: '', simhash: null, prefer: null, lang: '', home: false };
  const bare = ML_SITES.map((s) => ({ ...s, pages: strip({ pages: s.pages }).pages }));
  assert.ok(suggestTargets([{ ...one, dropped: false }], bare, cfg).get(one.path).some((c) => c.site === 'tr')); // both sites match
  assert.ok(suggestTargets([{ ...one, dropped: true }], bare, cfg).get(one.path).every((c) => c.site === 'heir'));
});
await check('ana sayfa: eski ana sayfaya doğru dilin ana sayfası önerilir, başka sayfaya önerilmez', async () => {
  assert.ok(isHomeLike('/tr/home', cfg) && isHomeLike('/fr/page-daccueil/', cfg) && isHomeLike('/tr', cfg) && isHomeLike('/en-gb', cfg));
  assert.ok(!isHomeLike('/', cfg) && !isHomeLike('/tr/hakkimda', cfg) && !isHomeLike('/blog', cfg) && !isHomeLike('/homes/x', cfg));
  const m = buildRedirectMap(await mlMatch(WRONG), ML_OLD, ML_SITES, {}, cfg);
  const tr = row('/tr/home', m), fr = row('/fr/page-daccueil', m);
  assert.deepEqual([tr.target.site, tr.target.path, tr.conf, tr.why], ['tr', '/', 'high', 'Eski sayfa bir ana sayfa']);
  assert.deepEqual([fr.target.site, fr.target.path], ['heir', '/']);
  assert.ok(m.rows.filter((x) => !['/tr/home', '/fr/page-daccueil'].includes(x.path)).every((x) => (x.candidates || []).every((c) => c.path !== '/')));
});
await check('bölüm uyarısı: yanlış dil ve hiç sayfa bulmayan seçim daha iyi seçimi söyler', async () => {
  const secs = sectionTable(await mlMatch(WRONG), { minPages: 3 });
  const tr = secs.find((x) => x.from === '/tr/*');
  assert.equal(tr.lang, 'tr');
  assert.deepEqual([tr.alert.kind, tr.alert.lang, tr.alert.curLang], ['lang', 'tr', 'en']);
  assert.deepEqual([tr.alert.better.host, tr.alert.better.to, tr.alert.better.hits], ['tr.ornek.com', '/*', 2]);
  assert.equal(secs.find((x) => x.from === '/fr/*').alert, null); // no French site: removing is a valid choice
  // Right decision: no alert.
  const ok = sectionTable(await mlMatch([{ from: '/tr/*', host: 'tr.ornek.com', to: '/*' }, { from: '/fr/*', drop: true }]), { minPages: 3 });
  assert.equal(ok.find((x) => x.from === '/tr/*').alert, null);
  // Same language, but the choice finds no page: kind 'zero'.
  const z = sectionTable(await mlMatch([{ from: '/tr/*', host: 'tr.ornek.com', to: '/tr/*' }]), { minPages: 3 }).find((x) => x.from === '/tr/*');
  assert.deepEqual([z.alert.kind, z.alert.hits, z.alert.better.to], ['zero', 0, '/*']);
  // Turkish section removed while a Turkish site has its pages: kind 'lang-drop'.
  const d = sectionTable(await mlMatch([{ from: '/tr/*', drop: true }]), { minPages: 3 }).find((x) => x.from === '/tr/*');
  assert.deepEqual([d.alert.kind, d.alert.better.host], ['lang-drop', 'tr.ornek.com']);
});
await check('Excel kaynağı: onaydan sonra da araç önerisi ve kaynak görünür', async () => {
  const c = await mlMatch(WRONG);
  const m = buildRedirectMap(c, ML_OLD, ML_SITES, {
    '/tr/hakkimda': { site: 'tr', path: '/hakkimda', src: 'oneri' }, '/tr/iletisim': { site: 'heir', path: '/contact', src: 'oneri' },
    '/prosedur/botox-2': { gone: true, src: 'elle' }, '/tr/prosedur/botoks': { url: 'https://x.test/b', src: 'elle' },
  }, cfg);
  assert.equal(mapSource(row('/tr/hakkimda', m)), 'İlk öneri onaylandı');
  assert.equal(mapSource(row('/tr/iletisim', m)), 'Listeden başka öneri');
  assert.equal(mapSource(row('/prosedur/botox-2', m)), '410 (araç öneri vermişti)');
  assert.equal(mapSource(row('/tr/prosedur/botoks', m)), 'Elle yazıldı');
  assert.equal(mapSource(row('/fr/prosedur/botox', m)), 'Araç önerisi');
  assert.equal(row('/prosedur/botox-2', m).candidates[0].path, '/procedures/medical-aesthetics/botox');
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
