// Tests for the work list by place (v0.9.0): server, new sites, content, decisions, site readiness. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTodo, siteReadiness } from '../src/todo.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Yapılacaklar testi');

const cfg = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url))).todo;
const HEIR = 'staging.ornek.com', TR = 'tr.ornek.com';
const O = (p) => `https://www.eski.com${p}`;
const row = (path, site, x = {}) => ({ path, oldUrl: O(path), oldTitle: path, site, indexable: true, inlinks: 1, ...x });
const many = (n, prefix, site, x) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, site, x));

// Comparison rows: every group the work list reads.
const cmp = {
  rows: {
    same: 20,
    lost: [row('/kayip-a', HEIR), row('/kayip-b', HEIR)],
    redirected: [
      row('/zincir', HEIR, { target: 'https://staging.ornek.com/z', status: 301, hops: 2, targetBroken: false }),
      row('/gecici', HEIR, { target: 'https://staging.ornek.com/g', status: 302, hops: 1, targetBroken: false }),
      row('/dogru', HEIR, { target: 'https://staging.ornek.com/d', status: 301, hops: 1, targetBroken: false }),
      row('/kirik', HEIR, { target: 'https://staging.ornek.com/k', status: 301, hops: 1, targetBroken: true }),
    ],
    changed: [row('/icerik', HEIR, { newUrl: 'https://staging.ornek.com/icerik', changes: [
      { field: 'title', kind: 'lost' }, { field: 'meta', kind: 'lost' }, { field: 'h1', kind: 'changed' }] })],
    unlinked: [row('/linksiz', HEIR, { newUrl: 'https://staging.ornek.com/linksiz', todo: 'Link verin.' })],
    unknown: [row('/sifreli', HEIR, { reason: 'Erişim engeli (401)', todo: 'Şifreyi kaldırın.' })],
    removed: [row('/fr/x', HEIR, { dropped: true })],
    moved: [
      row('/tr/kurulu', TR, { newUrl: 'https://tr.ornek.com/kurulu', status: 301, hops: 1, changes: [] }),
      row('/tr/gecici', TR, { newUrl: 'https://tr.ornek.com/gecici', status: 302, hops: 1, changes: [{ field: 'noindex', kind: 'lost' }], targetUnlinked: true }),
    ],
    no301: [row('/tr/eksik', TR, { todo: 'Eski alan adına geçecek sitede 301 kurun.' })],
    notarget: [row('/tr/yok-1', TR, { expectUrl: 'https://tr.eski.com/yok-1', todo: 'Sayfayı oluşturun.' }), row('/tr/yok-2', TR, { expectUrl: 'https://tr.eski.com/yok-2' })],
    added: [],
  },
};
const T = (site, path) => ({ site, path, url: `https://x/${path}` });
const map = { rows: [
  { path: '/tr/kurulu', oldUrl: O('/tr/kurulu'), kind: 'rule', installed: true, status: 'rule', target: T('tr', '/kurulu') },
  { path: '/tr/eksik', oldUrl: O('/tr/eksik'), kind: 'rule', installed: false, status: 'rule', target: T('tr', '/eksik'), why: 'Kural: /tr/*' },
  { path: '/kayip-a', oldUrl: O('/kayip-a'), kind: 'suggest', from: 'lost', status: 'approved', target: T('heir', '/a'), decision: { site: 'heir', path: '/a', src: 'oneri' }, warn: '' },
  { path: '/kayip-b', oldUrl: O('/kayip-b'), kind: 'suggest', from: 'lost', status: 'pending', target: T('heir', '/b') },
  { path: '/kirik', oldUrl: O('/kirik'), kind: 'suggest', from: 'broken', status: 'none', target: null },
  { path: '/fr/x', oldUrl: O('/fr/x'), kind: 'suggest', from: 'removed', status: 'gone', target: null, decision: { gone: true } },
  { path: '/tr/yok-1', oldUrl: O('/tr/yok-1'), kind: 'suggest', from: 'notarget', status: 'pending', target: T('tr', '/b') },
  { path: '/tr/yok-2', oldUrl: O('/tr/yok-2'), kind: 'suggest', from: 'notarget', status: 'approved', target: T('tr', '/yeni'), decision: { site: 'tr', path: '/yeni' }, warn: 'Hedef sayfa son taramada yok. Sayfayı kontrol edin.' },
] };
const sections = [{ from: '/tr/*', alert: { kind: 'lang' } }, { from: '/blog/*' }];
const SITES = [
  { key: 'heir', role: 'heir', host: HEIR, okPages: 40, crawlId: 'c-heir' },
  { key: 'tr', role: 'extra', name: 'Türkçe', host: TR, okPages: 30, crawlId: 'c-tr' },
];
const build = (x = {}) => buildTodo({ cmp, map, sections, sites: SITES, oldHost: 'www.eski.com', cfg, ...x });
const place = (t, key) => t.places.find((p) => p.key === key);
const n = (p, kind) => p.tasks.find((t) => t.kind === kind)?.n || 0;
const paths = (t, placeKey, task) => t.items.filter((i) => i.placeKey === placeKey && i.task === task).map((i) => i.path).sort();

await check('sunucu: 301 listesi kurulu olmayanları, düzeltmeleri ve 410\'u verir', () => {
  const t = build();
  const s = place(t, 'server');
  assert.equal(s.title, 'eski.com sunucusu');
  assert.deepEqual(paths(t, 'server', '301'), ['/kayip-a', '/tr/eksik', '/tr/yok-2']); // kurulu kural ve bekleyen öneri yok
  assert.deepEqual(paths(t, 'server', 'fix'), ['/gecici', '/tr/gecici', '/zincir']); // kırık hedef haritada, doğru 301 iş değil
  assert.deepEqual(paths(t, 'server', '410'), ['/fr/x']);
  assert.equal(s.n, 7);
  assert.match(t.items.find((i) => i.path === '/zincir').note, /Zincir 2 adım/);
});
await check('yeni site: eksik hedef sayfa ve linksiz sayfa doğru siteye gider', () => {
  const t = build();
  assert.deepEqual(paths(t, 'site:tr', 'create'), ['/tr/yok-1', '/tr/yok-2']); // kural hedefi yok + haritada seçilen hedef yok
  assert.deepEqual(paths(t, 'site:tr', 'link'), ['/tr/gecici']);
  assert.deepEqual(paths(t, 'site:heir', 'link'), ['/linksiz']);
  assert.equal(place(t, 'site:heir').role, 'heir');
});
await check('içerik: her kayıp alan bir iş, değişen alan iş değil', () => {
  const t = build();
  const c = place(t, 'content');
  assert.deepEqual([n(c, 'title'), n(c, 'meta'), n(c, 'h1'), n(c, 'noindex')], [1, 1, 0, 1]);
  assert.deepEqual(c.tasks.map((x) => x.kind), ['meta', 'title', 'noindex']);
});
await check('karar: haritada açık satır, bölüm uyarısı, kontrol edilemeyen sayfa', () => {
  const t = build();
  assert.deepEqual(paths(t, 'decide', 'map'), ['/kayip-b', '/kirik']); // /tr/yok-1 sayfa oluşturma işinde, iki kere sayılmaz
  assert.deepEqual(paths(t, 'decide', 'section'), ['/tr/*']);
  assert.deepEqual(paths(t, 'decide', 'unknown'), ['/sifreli']);
  assert.equal(t.total, t.places.reduce((a, p) => a + p.n, 0));
  assert.equal(t.held, 0);
});
await check('hazır olmayan site: işleri bekler, sunucu işleri beklemez', () => {
  const thin = SITES.map((s) => (s.key === 'tr' ? { ...s, okPages: 1 } : s));
  const big = { ...cmp, rows: { ...cmp.rows, notarget: [...cmp.rows.notarget, ...many(10, '/tr/p', TR)] } };
  const t = build({ sites: thin, cmp: big });
  assert.deepEqual(t.ready.tr, { state: 'thin', oldPages: 15, newPages: 1 }); // taşınan 2 + 301 eksik 1 + hedef yok 12
  assert.equal(t.ready.heir.state, 'ok');
  const tr = place(t, 'site:tr');
  assert.deepEqual([tr.n, tr.held], [0, 14]); // 12 sayfa oluşturma + 1 link + 1 noindex (içerik)
  assert.equal(place(t, 'content').tasks.find((x) => x.kind === 'noindex'), undefined);
  assert.deepEqual(paths(t, 'server', '301'), ['/kayip-a', '/tr/eksik', '/tr/yok-2']);
  assert.equal(t.total, t.places.reduce((a, p) => a + p.n, 0));
  assert.ok(t.items.filter((i) => i.held).every((i) => i.site === 'tr'));
});
await check('hazır olmayan site: kullanıcı kabul edince işler sayılır, yeni tarama kabulü düşürür', () => {
  const thin = SITES.map((s) => (s.key === 'tr' ? { ...s, okPages: 1 } : s));
  const big = { ...cmp, rows: { ...cmp.rows, notarget: [...cmp.rows.notarget, ...many(10, '/tr/p', TR)] } };
  const ok = build({ sites: thin, cmp: big, readyOk: { tr: 'c-tr' } });
  assert.equal(ok.ready.tr.state, 'accepted');
  assert.deepEqual([place(ok, 'site:tr').n, ok.held], [13, 0]);
  assert.equal(build({ sites: thin, cmp: big, readyOk: { tr: 'eski-tarama' } }).ready.tr.state, 'thin');
});
await check('hazırlık: az eski sayfa veya yeterli yeni sayfa uyarı vermez', () => {
  const r = siteReadiness(cmp, SITES.map((s) => ({ ...s, okPages: 1 })), {}, cfg);
  assert.equal(r.tr.state, 'ok'); // sadece 4 eski sayfa: kontrol için az
  assert.equal(r.heir.state, 'thin'); // 29 eski sayfa, 1 yeni sayfa
  assert.equal(r.heir.oldPages, 29); // same 20 + lost 2 + redirected 4 + changed + unlinked + unknown (removed sayılmaz)
  assert.equal(siteReadiness(cmp, SITES.map((s) => ({ ...s, okPages: 9 })), {}, cfg).heir.state, 'ok'); // 9 ≥ 29 × 0.3
});

console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
