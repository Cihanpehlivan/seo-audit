// Tests for the live check (v0.11.0, Part 3b). Real requests and real crawls of local live sites, no network.
// The crawls before launch (old site, staging) are built here: after launch they are files, not sites.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crawl } from '../src/crawler.js';
import { parseRules } from '../src/compare.js';
import { makeIsStaging } from '../src/launch.js';
import { makeGuard } from '../src/netguard.js';
import { expectedList, checkRedirects, buildVerify, makeRequest, classify, hostKey } from '../src/verify.js';
import { startVerifySites, STAGING, TR_STAGING } from './fixture-verify.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Canlı doğrulama testi');

const cfg = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url)));
const srv = await startVerifySites();

// A page as the crawler writes it. tracking/gscVerify: tag data (v0.10.0+).
const pg = (url, x = {}) => ({ url, status: 200, contentType: 'text/html; charset=utf-8', redirectChain: [], title: url, metaDescription: 'x', h1: [url], metaRobots: '', canonical: url, inlinks: 1, htmlLang: 'tr', ...x });
const res = (origin, paths, x = {}, meta = {}) => ({ meta: { host: new URL(origin).hostname, startUrl: `${origin}/`, startedAt: '2026-11-18T10:00:00Z', ...meta },
  pages: paths.map((p) => pg(origin + p, typeof x === 'function' ? x(p) : x)) });
const OLD_TAGS = (p) => ({ tracking: ['G-XY34Z99', 'GTM-AB12CD'], gscVerify: p === '/' ? ['eskiDeger123'] : [] });
const SM = { sitemap: { files: [{ url: 'x/sitemap.xml', status: 200, urlCount: 3 }] } };

// One project: the old domain (live = the heir), a Turkish site (/tr/* → tr site). heir and tr are staging crawls.
function project({ live, trLive, oldPaths, heirPaths, trPaths = ['/', '/a'], decisions, heirExtra = [], oldTags = true }) {
  const oldRes = res(live, oldPaths, oldTags ? OLD_TAGS : {}, SM);
  const heir = res(`https://${STAGING}`, heirPaths);
  heir.pages.push(...heirExtra);
  const tr = res(`https://${TR_STAGING}`, trPaths);
  const sites = [
    { key: 'heir', role: 'heir', host: STAGING, origin: `https://${STAGING}`, liveOrigin: live, pages: heir.pages },
    { key: 'tr', role: 'extra', name: 'Türkçe', host: TR_STAGING, origin: `https://${TR_STAGING}`, liveOrigin: trLive, pages: tr.pages },
  ];
  const rules = parseRules([{ from: '/tr/*', host: TR_STAGING, to: '/*' }], 50);
  const liveMap = trLive ? { [TR_STAGING]: new URL(trLive).host } : {};
  const exp = expectedList({ oldRes, newList: [heir, tr], sites, rules, live: liveMap, decisions, cfg });
  const isStg = makeIsStaging(sites.map((s) => ({ host: s.host, liveHost: s.liveOrigin ? new URL(s.liveOrigin).hostname : '', staging: true })), cfg);
  const allowed = new Set([hostKey(live), ...(trLive ? [hostKey(trLive)] : [])]);
  return { oldRes, sites, exp, isStg, allowed };
}
const asked = [];
const request = makeRequest({ timeoutMs: 3000 });
const recording = async (u) => { asked.push(u); return request(u); };
const crawlOpt = { maxUrls: 50, concurrency: 2, delayMs: 0, ignoreRobots: true };

// ---------- Broken live site ----------
const DEC = Object.fromEntries('abcdefgh'.split('').map((x) => [`/urun/${x}`, { site: 'heir', path: `/kahveler/${x}`, src: 'oneri' }]));
Object.assign(DEC, { '/eski-kampanya': { gone: true, src: 'elle' }, '/eski-haber': { gone: true, src: 'elle' } });
const B = project({
  live: srv.bozuk.origin, trLive: srv.trBozuk.origin, decisions: DEC,
  oldPaths: ['/', '/hakkimizda', '/gizli', ...'abcdefgh'.split('').map((x) => `/urun/${x}`), '/eski-kampanya', '/eski-haber', '/tr/a', '/blog/x', '/blog/y'],
  heirPaths: ['/', '/hakkimizda', '/gizli', '/blog', ...'abcdefgh'.split('').map((x) => `/kahveler/${x}`)],
});
const checkedB = await checkRedirects(B.exp.rows, recording, { allowed: B.allowed, isStg: B.isStg, concurrency: 4 });
const kindOf = (rows, p) => rows.find((r) => r.path === p)?.kind;
const [liveB, liveTrB] = await Promise.all([crawl(`${srv.bozuk.origin}/`, crawlOpt), crawl(`${srv.trBozuk.origin}/`, crawlOpt)]);
const VB = buildVerify({ checked: checkedB, oldRes: B.oldRes, isStg: B.isStg, cfg, liveSites: [
  { ...B.sites[0], state: 'done', res: liveB }, { ...B.sites[1], state: 'done', res: liveTrB },
] });
const item = (V, kind, site) => V.groups.flatMap((g) => g.items).find((i) => i.kind === kind && (site === undefined || i.site === site));

await check('beklenen liste: istek yok, kararlar, kural, aynı adres ve karar yok satırları', () => {
  const e = (p) => B.exp.rows.find((r) => r.path === p);
  assert.deepEqual([e('/urun/a').expect, e('/urun/a').target, e('/urun/a').src], ['301', `${srv.bozuk.origin}/kahveler/a`, 'Onay']);
  assert.deepEqual([e('/eski-haber').expect, e('/eski-kampanya').expect], ['410', '410']);
  assert.deepEqual([e('/tr/a').expect, e('/tr/a').target, e('/tr/a').src], ['301', `${srv.trBozuk.origin}/a`, 'Kural']);
  assert.deepEqual([e('/hakkimizda').expect, e('/blog/x').expect], ['200', 'open']);
  assert.equal(B.exp.rows.length, 16);
});
await check('beklenen liste: staging\'de kurulu 301 listeden düşmez, karar staging yönlendirmesinden önce gelir', () => {
  const redirect = (from, to) => ({ ...pg(`https://${STAGING}${from}`), status: 301, redirectChain: [{ url: `https://${STAGING}${from}`, status: 301 }], finalUrl: `https://${STAGING}${to}`, finalStatus: 200 });
  const P = project({ live: 'https://www.eski.com', trLive: 'https://tr.eski.com', oldPaths: ['/', '/urun/z', '/eski-yol'], heirPaths: ['/', '/yeni-z', '/yeni-yol'],
    heirExtra: [redirect('/urun/z', '/baska'), redirect('/eski-yol', '/yeni-yol')], decisions: { '/urun/z': { site: 'heir', path: '/yeni-z', src: 'oneri' } } });
  const e = (p) => P.exp.rows.find((r) => r.path === p);
  assert.deepEqual([e('/urun/z').expect, e('/urun/z').target], ['301', 'https://www.eski.com/yeni-z']);
  assert.deepEqual([e('/eski-yol').target, e('/eski-yol').src], ['https://www.eski.com/yeni-yol', 'Staging yönlendirmesi']);
});
await check('301 listesi: her sonuç doğru sınıflanır', () => {
  const want = {
    '/': 'ok-200', '/hakkimizda': 'page-gone', '/gizli': 'auth', '/urun/a': 'ok-301', '/urun/b': 'no301', '/urun/c': 'chain', '/urun/d': 'temp',
    '/urun/e': 'wrong-target', '/urun/f': 'target-bad', '/urun/g': 'no301-open', '/urun/h': 'to-staging', '/eski-kampanya': 'no410',
    '/eski-haber': 'ok-410', '/tr/a': 'ok-301', '/blog/x': 'lost', '/blog/y': 'ok-open',
  };
  for (const [p, k] of Object.entries(want)) assert.equal(kindOf(checkedB, p), k, p);
  assert.match(checkedB.find((r) => r.path === '/urun/c').got, /^301 → 301 → 200$/);
});
await check('SSRF: istek sadece projenin canlı alan adlarına gider', () => {
  const hosts = new Set(asked.map(hostKey));
  assert.deepEqual([...hosts].sort(), [...B.allowed].sort());
  assert.ok(!asked.some((u) => u.includes(STAGING)), 'staging istenmemeli');
  const n = asked.filter((u) => u === `${srv.bozuk.origin}/kahveler/c`).length;
  assert.equal(n, 1, 'aynı adres bir kez istenir');
});
await check('canlı site: noindex, Disallow ve staging adresi kritik', () => {
  assert.deepEqual([item(VB, 'live-noindex', 'heir').n, item(VB, 'live-noindex', 'heir').detail], [2, { meta: 1, header: 1 }]);
  assert.equal(item(VB, 'live-disallow', 'heir').group, 'critical');
  assert.deepEqual(item(VB, 'live-staging-addr', 'heir').detail, { canonical: 1, sitemap: 1 });
});
await check('canlı site: eksik etiket ve sitemap sorunları düzeltin grubunda', () => {
  assert.deepEqual(['live-tracking', 'live-gsc', 'sitemap-host', 'sitemap-status'].map((k) => item(VB, k, 'heir')?.group), ['fix', 'fix', 'fix', 'fix']);
  assert.equal(item(VB, 'sitemap-status', 'heir').list[0].page, `${srv.bozuk.origin}/hakkimizda`);
  assert.equal(item(VB, 'live-gsc', 'tr'), undefined); // the Search Console tag stays only on the old domain
  assert.equal(item(VB, 'sitemap-missing', 'tr').group, 'fix');
  assert.deepEqual(VB.counts, { critical: 8, fix: 11, unknown: 1 });
  assert.deepEqual(VB.redirects, { total: 16, critical: 5, fix: 5, unknown: 1, ok: 5 });
  assert.equal(VB.notSwitched, false);
});

// ---------- Clean live site ----------
const C = project({
  live: srv.temiz.origin, trLive: srv.trTemiz.origin, oldPaths: ['/', '/urun/a', '/eski', '/tr/a', '/blog'], heirPaths: ['/', '/blog', '/kahveler/a'],
  decisions: { '/urun/a': { site: 'heir', path: '/kahveler/a', src: 'elle' }, '/eski': { gone: true, src: 'elle' } },
});
const checkedC = await checkRedirects(C.exp.rows, request, { allowed: C.allowed, isStg: C.isStg });
const [liveC, liveTrC] = await Promise.all([crawl(`${srv.temiz.origin}/`, crawlOpt), crawl(`${srv.trTemiz.origin}/`, crawlOpt)]);
const VC = buildVerify({ checked: checkedC, oldRes: C.oldRes, isStg: C.isStg, cfg, liveSites: [
  { ...C.sites[0], state: 'done', res: liveC }, { ...C.sites[1], state: 'done', res: liveTrC },
] });
await check('temiz canlı site: hiçbir iş yok', () => {
  const work = VC.groups.filter((g) => g.key !== 'ok').flatMap((g) => g.items).map((i) => `${i.kind}:${i.site}`);
  assert.deepEqual(work, []);
  assert.equal(VC.total, 0);
  assert.deepEqual(VC.redirects, { total: 5, critical: 0, fix: 0, unknown: 0, ok: 5 });
  assert.deepEqual(VC.groups.find((g) => g.key === 'ok').items.map((i) => `${i.kind}:${i.site}`).sort(),
    ['live-clean:heir', 'live-clean:tr', 'live-sitemap:heir', 'live-sitemap:tr', 'live-tags:heir', 'live-tags:tr', 'ok-200:server', 'ok-301:server', 'ok-410:server']);
});

// ---------- Blocked checks ----------
await check('canlı alan adı yok: site ve satırları kontrol edilemedi, iş projede', async () => {
  const N = project({ live: srv.temiz.origin, trLive: null, oldPaths: ['/', '/tr/a'], heirPaths: ['/'], decisions: {} });
  const rows = await checkRedirects(N.exp.rows, request, { allowed: N.allowed, isStg: N.isStg });
  assert.equal(kindOf(rows, '/tr/a'), 'nolive');
  const V = buildVerify({ checked: rows, oldRes: N.oldRes, isStg: N.isStg, cfg, liveSites: [{ ...N.sites[0], state: 'none' }, { ...N.sites[1], state: 'none' }] });
  const nl = item(V, 'nolive', 'tr');
  assert.deepEqual([nl.group, nl.n, nl.action.type], ['unknown', 1, 'project']);
  assert.equal(V.sites.find((s) => s.key === 'tr').state, 'nolive');
  assert.deepEqual([item(V, 'live-nocrawl', 'heir').action.type, item(V, 'live-nocrawl', 'tr')], ['crawl-live', undefined]);
});
await check('eski tarama etiket verisi içermiyorsa araç tekrar tarama istemez', () => {
  const O = project({ live: srv.temiz.origin, trLive: srv.trTemiz.origin, oldPaths: ['/'], heirPaths: ['/'], decisions: {}, oldTags: false });
  const V = buildVerify({ checked: [], oldRes: O.oldRes, isStg: O.isStg, cfg, liveSites: [{ ...O.sites[0], state: 'done', res: liveC }] });
  assert.equal(item(V, 'old-tags', 'old').action, null);
  assert.equal(item(V, 'live-tracking', 'heir'), undefined);
});
await check('geçiş yapılmadı: 301 beklenen adreslerin çoğu 200 veriyor', async () => {
  const rows = ['/a', '/b', '/c', '/d'].map((p) => ({ path: p, oldUrl: `https://www.eski.com${p}`, expect: '301', target: `https://www.eski.com/yeni${p}` }));
  const out = await checkRedirects(rows, async () => ({ status: 200 }), { allowed: new Set(['eski.com']) });
  const V = buildVerify({ checked: out, oldRes: C.oldRes, isStg: () => false, cfg, liveSites: [] });
  assert.equal(V.notSwitched, true);
  assert.equal(V.counts.fix, 1);
});
await check('yayın modu: iç ağ adresi istenmez, sonuç kontrol edilemedi', async () => {
  const guarded = makeRequest({ guard: makeGuard(), timeoutMs: 3000 });
  const out = await checkRedirects(C.exp.rows.slice(0, 2), guarded, { allowed: C.allowed });
  assert.deepEqual(out.map((r) => r.kind), ['blocked', 'blocked']);
  assert.equal(classify({ expect: '301', target: 'https://x/' }, { chain: [301], left: `http://${STAGING}/a` }, () => false), 'outside');
});
await check('yayın modu: kontrol sınırı aşılınca kalan adresler kontrol edilemedi', async () => {
  const out = await checkRedirects(C.exp.rows, request, { allowed: C.allowed, maxChecks: 2, concurrency: 1 });
  assert.deepEqual(out.map((r) => r.kind).filter((k) => k === 'limit').length, C.exp.rows.length - 2);
});

for (const s of Object.values(srv)) s.close();
console.log(`${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
