// Tests for the launch list (v0.10.0, Part 3a). Real crawls of local fixture sites, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crawl } from '../src/crawler.js';
import { parsePage } from '../src/parser.js';
import { buildLaunch } from '../src/launch.js';
import { startLaunchSites, LIVE, AUTH } from './fixture-launch.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Canlıya çıkış testi');

const cfg = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url)));
const srv = await startLaunchSites();
const url = (s) => `http://127.0.0.1:${s.address().port}/`;
const opt = { maxUrls: 50, concurrency: 2, delayMs: 0 };
const [oldRes, kirli, acik, temiz] = await Promise.all([
  crawl(url(srv.old), opt),
  crawl(url(srv.kirli), { ...opt, ignoreRobots: true }),
  crawl(url(srv.acik), opt),
  crawl(url(srv.temiz), { ...opt, auth: AUTH }),
]);
const K = url(srv.kirli).slice(0, -1), A = url(srv.acik).slice(0, -1);

// 301 map: a rule row to a site without a live domain, a manual staging address, a pending row, a correct row.
const map = { noLive: ['tr'], rows: [
  { path: '/tr/a', oldUrl: 'https://www.eski.com/tr/a', status: 'rule', target: { site: 'tr', path: '/a', url: `${A}/a` } },
  { path: '/x', oldUrl: 'https://www.eski.com/x', status: 'approved', target: { url: `${K}/x` }, decision: { url: `${K}/x`, src: 'elle' } },
  { path: '/y', oldUrl: 'https://www.eski.com/y', status: 'pending', target: { site: 'heir', path: '/a', url: `${LIVE}/a` } },
  { path: '/z', oldUrl: 'https://www.eski.com/z', status: 'approved', target: { site: 'heir', path: '/b', url: `${LIVE}/b` } },
] };
const L = buildLaunch({ oldRes, map, cfg, sites: [
  { key: 'heir', role: 'heir', res: kirli, liveOrigin: LIVE },
  { key: 'tr', role: 'extra', res: acik, liveOrigin: null },
] });
const item = (kind, site) => L.groups.flatMap((g) => g.items).find((i) => i.kind === kind && (site === undefined || i.site === site));

await check('veri: parser etiket kimliklerini sadece scriptten okur', () => {
  const home = oldRes.pages.find((p) => p.url === url(srv.old));
  assert.deepEqual(home.tracking.sort(), ['G-XY34Z99', 'GTM-AB12CD']); // "G-METIN123" is page text
  assert.deepEqual(home.gscVerify, ['eskiDeger123']);
});
await check('veri: göreli canonical açık host sayılmaz, sitemap hostları kaydedilir', () => {
  const b = kirli.pages.find((p) => p.url.endsWith('/b'));
  assert.equal(b.absHosts.canonical, '');
  assert.equal(kirli.meta.sitemap.hosts['127.0.0.1'], 3);
  const p = parsePage('<a href="//cdn.ornek.com/x">x</a><img src="/i.png">', 'https://s.ornek.com/', 's.ornek.com');
  assert.deepEqual(p.absHosts.link, ['cdn.ornek.com']);
  assert.deepEqual(p.absHosts.asset, []);
});
await check('kritik: 301 listesinde staging adresi, canlı alan adı yoksa proje, elle yazıldıysa harita', () => {
  const tr = item('map-staging', 'tr'), manual = item('map-staging', null);
  assert.equal(tr.n, 1); assert.equal(tr.action.type, 'project');
  assert.equal(manual.n, 1); assert.equal(manual.action.type, 'map');
  assert.equal(L.groups.flatMap((g) => g.items).filter((i) => i.kind === 'map-staging').length, 2); // the live rows are not listed
});
await check('kritik: sitede staging adresi (canonical, hreflang, link, görsel, sitemap, robots.txt)', () => {
  const it = item('staging-addr', 'heir');
  assert.deepEqual(it.detail, { canonical: 2, hreflang: 1, link: 1, asset: 1, sitemap: 3, robots: 1 });
  assert.equal(it.group, 'critical');
});
await check('kritik: şifresiz, noindex ve Disallow olmayan staging Google\'a açık', () => {
  assert.equal(item('staging-open', 'tr').n, 2);
  assert.equal(item('staging-open', 'heir'), undefined); // noindex and Disallow close it
});
await check('çıkışta: noindex (meta ve X-Robots-Tag) ve Disallow: / kritik değildir', () => {
  const n = item('noindex', 'heir');
  assert.equal(n.group, 'switch'); assert.equal(n.n, 2); assert.deepEqual(n.detail, { meta: 1, header: 1 });
  assert.equal(item('disallow', 'heir').group, 'switch');
  assert.equal(item('disallow', 'tr'), undefined); // Disallow: /admin/ only
});
await check('karar: haritada bekleyen satır', () => assert.equal(item('map-pending').n, 1));
await check('kontrol: eksik etiket iş, farklı kimlik bilgi satırıdır', () => {
  const h = item('tracking', 'heir'), t = item('tracking', 'tr');
  assert.equal(h.info, false); assert.equal(h.n, 2);
  assert.equal(t.info, true); assert.match(t.note, /G-YENI1234/);
  assert.equal(item('gsc', 'heir').info, false);
  assert.equal(item('gsc', 'tr'), undefined); // only the heir keeps the old domain
  assert.deepEqual(L.counts, { critical: 4, decide: 1, switch: 2, check: 2 });
});

await check('temiz staging: hiçbir iş yok', () => {
  const C = buildLaunch({ oldRes, cfg, map: { noLive: [], rows: [map.rows[3]] }, sites: [{ key: 'heir', role: 'heir', res: temiz, liveOrigin: LIVE }] });
  assert.equal(temiz.pages.filter((p) => p.status === 200).length, 3); // the password worked
  assert.deepEqual(C.groups.flatMap((g) => g.items).map((i) => i.kind), []);
  assert.equal(C.total, 0);
});
await check('canlı alan adında taranan site staging sayılmaz', () => {
  const C = buildLaunch({ oldRes, cfg, map: null, sites: [{ key: 'heir', role: 'heir', res: acik, liveOrigin: A }] });
  assert.equal(C.sites[0].staging, false);
  assert.equal(C.groups.flatMap((g) => g.items).some((i) => ['staging-open', 'staging-addr', 'noindex', 'disallow'].includes(i.kind)), false);
});
await check('eski tarama: veri yoksa "Tarama eski" der, yanlış iş üretmez', () => {
  const strip = (res) => ({ ...res, meta: { ...res.meta, sitemap: { files: [], urlCount: 0 } },
    pages: res.pages.map(({ absHosts, tracking, gscVerify, ...p }) => p) });
  const C = buildLaunch({ oldRes: strip(oldRes), cfg, map: null, sites: [{ key: 'heir', role: 'heir', res: strip(kirli), liveOrigin: LIVE }] });
  const kinds = C.groups.flatMap((g) => g.items).map((i) => `${i.kind}:${i.site}`).sort();
  assert.deepEqual(kinds, ['disallow:heir', 'noindex:heir', 'recrawl:heir', 'recrawl:old', 'staging-addr:heir']); // robots.txt line still read
  assert.deepEqual(C.groups[0].items[0].detail, { robots: 1 });
});

for (const s of Object.values(srv)) s.close();
console.log(`${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
