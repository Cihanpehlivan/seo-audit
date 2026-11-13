// Live check (v0.11.0, Sprint 3 Part 3b). After launch the tool proves that the migration works on the live domains.
//   A. Every old address on the live old domain: the 301, the 410 or the page itself.
//   B. Staging settings left on the live site (noindex, X-Robots-Tag, "Disallow: /", staging addresses).
//   C. Tags of the old site on the live site (Analytics/GTM, Search Console).
//   D. Sitemap: live addresses only, every address 200.
// Groups: critical (traffic and index loss), fix (opens but not right), unknown (not checked, never counted as done), ok.
// Not part of the rule engine: the checks need the live domains, the 301 decisions and the crawls before launch.
//
// The expected list comes from the crawls before launch and the decisions, WITHOUT requests (v0.11.0 decision).
// Reason (tested): the 301 map of the matching screen asks staging. A 301 already set up on staging leaves that list.
// After launch staging can also be closed. So the expected list must not depend on staging answers.
import { compareCrawls, pathKey } from './compare.js';
import { buildRedirectMap } from './redirectmap.js';
import { isOk } from './rules/helpers.js';
import { stagingAddresses, indexBlockers, tagCheck, hasTagData } from './launch.js';
import { trafficOf, sortByTraffic, hasProof } from './urllist.js';

const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
// Host with port: test sites differ only by port. Real sites have no port, so this is the host.
export const hostKey = (u) => { try { return bare(new URL(u).host); } catch { return ''; } };
const hostName = (u) => { try { return bare(new URL(u).hostname); } catch { return ''; } };
const sameUrl = (a, b) => { try { return hostKey(a) === hostKey(b) && pathKey(a) === pathKey(b); } catch { return false; } };

export const VERIFY_GROUPS = [
  { key: 'critical', title: 'Kritik', sub: 'Trafik ve dizin kaybı. Hemen düzeltin.' },
  { key: 'fix', title: 'Düzeltin', sub: 'Sayfa açılıyor ama doğru değil.' },
  { key: 'unknown', title: 'Kontrol edilemedi', sub: 'Tamam sayılmaz. Nedeni çözün, sonra tekrar kontrol edin.' },
  { key: 'ok', title: 'Tamam', sub: '' },
];

// Result kinds of one old address: group, title, note. The team of every address is the old domain's server (Backend).
const R = {
  'no301': ['critical', '301 yok · eski adres hata veriyor', 'Eski adres yönlenmiyor ve hata veriyor. Sunucuya 301 kuralını ekleyin.'],
  'target-bad': ['critical', 'Hedef hatalı', 'Yönlendirme var ama hedef sayfa açılmıyor. Hedefi düzeltin veya sayfayı oluşturun.'],
  'to-staging': ['critical', 'Yanlış hedef: staging adresi', 'Eski adres staging alan adına gidiyor. 301 hedefi her zaman canlı alan adıdır.'],
  'lost': ['critical', 'Kayıp sayfa · haritada karar yok', 'Eski sayfa canlıda hata veriyor. 301 haritasında karar verin, sonra 301 veya 410 kurun.'],
  'page-gone': ['critical', 'Sayfa yok · aynı adreste olmalıydı', 'Sayfa staging\'de bu adreste vardı. Canlıda hata veriyor. Sayfayı yayınlayın.'],
  'no301-open': ['fix', '301 yok · eski adres açılıyor', 'Eski adres yönlenmiyor ve 200 veriyor. 301 kuralını ekleyin.'],
  'wrong-target': ['fix', 'Yanlış hedef', 'Yönlendirme başka bir sayfaya gidiyor. Hedefi listedeki adres ile değiştirin.'],
  'chain': ['fix', 'Zincir', 'Eski adres birden çok adımda gidiyor. Tek adımda hedefe yönlendirin.'],
  'temp': ['fix', 'Geçici yönlendirme (302, 307)', 'Geçici yönlendirme sıralamayı taşımaz. 301 kullanın.'],
  'no410': ['fix', '410 bekleniyordu, gelmedi', 'Haritada 410 kararı var. Sunucu başka yanıt veriyor. 410 kurun.'],
  'moved-page': ['fix', 'Sayfa yönleniyor · aynı adreste olmalıydı', 'Sayfa staging\'de bu adreste açılıyordu. Canlıda başka adrese gidiyor. Kontrol edin.'],
  'late-unproven': ['unknown', 'Eski sitede var mıydı bilinmiyor', 'Adres çıkıştan sonra listeden geldi. Araç eski sitede istemedi ve listede trafik yok. Liste bozuk olabilir. Sayfa vardıysa 301 haritasında karar verin, yoksa adresi listeden çıkarın.'],
  'blocked': ['unknown', 'İç ağ adresi', 'Yayın modunda araç iç ağ adreslerine istek atmaz. Doğrulamayı yerel kurulumda çalıştırın.'],
  'outside': ['unknown', 'Hedef proje dışında', 'Hedef bu projenin canlı alan adlarında değil. Araç başka alan adına istek atmaz. Elle kontrol edin.'],
  'auth': ['unknown', 'Erişim engeli (401, 403)', 'Sunucu aracı engelledi. Güvenlik duvarını veya bot korumasını kontrol edin.'],
  'error': ['unknown', 'İstenemedi', 'Bağlantı hatası veya zaman aşımı. Sonra tekrar kontrol edin.'],
  'limit': ['unknown', 'Kontrol sınırı', 'Yayın modunda kontrol edilen adres sayısı sınırlıdır. Kalan adresleri yerel kurulumda kontrol edin.'],
  'ok-301': ['ok', '301 doğru', ''],
  'ok-left': ['ok', '301 doğru · dış hedef', 'Yönlendirme beklenen dış adrese gidiyor. Araç başka alan adına istek atmaz: hedefin açıldığını kontrol etmedi.'],
  'ok-410': ['ok', '410 doğru', ''],
  'ok-200': ['ok', 'Aynı adreste açılıyor', ''],
  'ok-open': ['ok', 'Haritada karar yok, sayfa açılıyor', 'Adres açılıyor veya tek adımda yönleniyor. Haritada karar verin: liste sonra da doğru kalsın.'],
};
const ORDER = Object.keys(R);

// ---------- A. The expected list (no requests) ----------
// oldRes: old site crawl (before launch). newList: target site crawls (staging, before launch), heir first.
// sites: [{ key, host, origin, liveOrigin, pages }] same order. rules, live: as in the project matching.
// decisions: project.map. Returns { rows: [{ path, oldUrl, expect, target, site, src, hint, traffic }], map }.
// traffic (v0.12.1): path → { clicks, impressions, views, links } from the old address list. The map gets it (same
// order as the matching screen) and every row carries it. Rows come in traffic order: in public mode the request limit
// (yayin.maxUrls) then leaves the pages with less traffic unchecked.
// v0.12.1: a late page (old address list, never asked on the old site) gets late: true and proof (the list has a number
// at or over urlList.lateProof). An open late row that fails on the live site is "Kayıp sayfa" only with proof.
// redirects (v0.12.2): old redirects of the old site (src/urllist.js → oldRedirects). Their 301 map rows join the list.
export function expectedList({ oldRes, newList, sites, rules = [], live = {}, decisions = {}, cfg = {}, traffic = null, redirects = [] }) {
  const cmp = compareCrawls(oldRes, newList, { rules, live });
  // Without requests a moved page whose target is in the crawl stays in "moving": it is a rule row of the map.
  // Without the target in the crawl the map suggests a page (the same as the matching screen before the 301 exists).
  for (const r of cmp.rows.moving) (r.pendingTarget ? cmp.rows.moved : cmp.rows.notarget).push(r);
  cmp.rows.moving = [];
  const map = buildRedirectMap(cmp, oldRes, sites, decisions, cfg.redirectMap || {}, traffic, { redirects, staging: cfg });
  const noLive = new Set(sites.filter((s) => !s.liveOrigin).map((s) => s.key));
  const byStagingHost = new Map(sites.map((s) => [bare(s.host), s]));
  const mapRow = new Map(map.rows.map((r) => [r.path, r]));
  const redirected = new Map(cmp.rows.redirected.map((r) => [r.path, r]));
  const unknown = new Set(cmp.rows.unknown.map((r) => r.path));

  const rows = [];
  const seen = new Set();
  for (const p of oldRes.pages.filter(isOk)) {
    const path = pathKey(p.url);
    if (seen.has(path)) continue;
    seen.add(path);
    const base = { path, oldUrl: p.url, ...(p.late ? { late: true, proof: hasProof(traffic?.get(path), cfg.urlList?.lateProof || {}) } : {}) };
    const r = mapRow.get(path);
    if (r) {
      if (r.status === 'gone') { rows.push({ ...base, expect: '410', src: '410' }); continue; }
      if (r.status === 'rule' || r.status === 'approved') {
        const src = r.status === 'rule' ? 'Kural' : r.decision?.src === 'elle' ? 'Elle' : 'Onay';
        const site = r.target.site || null;
        rows.push({ ...base, expect: '301', src, site, target: site && noLive.has(site) ? null : r.target.url, noLive: !!(site && noLive.has(site)) });
        continue;
      }
      rows.push({ ...base, expect: 'open', src: p.late ? 'Karar yok · liste' : 'Karar yok', hint: r.target?.url || '' });
      continue;
    }
    // A decision of the user for a page the map does not list (staging already redirects it): the decision wins.
    const d = decisions[path];
    if (d?.gone) { rows.push({ ...base, expect: '410', src: '410' }); continue; }
    if (d?.url || d?.site) {
      const s = d.site ? sites.find((x) => x.key === d.site) : null;
      const src = d.src === 'elle' ? 'Elle' : 'Onay';
      if (s && !s.liveOrigin) { rows.push({ ...base, expect: '301', src, site: s.key, target: null, noLive: true }); continue; }
      if (d.url || s) { rows.push({ ...base, expect: '301', src, site: s?.key || null, target: d.url || new URL(d.path, s.liveOrigin).href }); continue; }
    }
    // Staging already redirected this old address (found by a link in the crawl): the live 301 goes to the same page.
    const rd = redirected.get(path);
    if (rd && !rd.targetBroken && rd.target) {
      const s = byStagingHost.get(hostName(rd.target));
      if (s && !s.liveOrigin) { rows.push({ ...base, expect: '301', src: 'Staging yönlendirmesi', site: s.key, target: null, noLive: true }); continue; }
      const t = s ? new URL(pathKey(rd.target), s.liveOrigin).href : rd.target;
      rows.push({ ...base, expect: '301', src: 'Staging yönlendirmesi', site: s?.key || null, target: t });
      continue;
    }
    if (unknown.has(path)) { rows.push({ ...base, expect: 'open', src: p.late ? 'Karar yok · liste' : 'Karar yok' }); continue; }
    // The page is on the heir at the same path: the live old domain gives the page itself.
    rows.push({ ...base, expect: '200', src: 'Aynı adres' });
  }
  // v0.12.2: old redirects. The row expects the new address of its target in one step (or 410). A row that waits
  // for the target's decision has no expectation yet: as an old page without a decision (404 = lost page).
  for (const r of map.rows.filter((x) => x.kind === 'follow')) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    const base = { path: r.path, oldUrl: r.oldUrl, redirect: true };
    if (r.status === 'gone' || (r.status === 'follow' && r.gone)) { rows.push({ ...base, expect: '410', src: r.status === 'gone' ? '410' : 'Eski yönlendirme · 410' }); continue; }
    if ((r.status === 'follow' || r.status === 'approved') && r.target) {
      const src = r.status === 'follow' ? 'Eski yönlendirme' : r.decision?.src === 'elle' ? 'Elle' : 'Onay';
      const site = r.target.site || null;
      rows.push({ ...base, expect: '301', src, site, target: site && noLive.has(site) ? null : r.target.url, noLive: !!(site && noLive.has(site)) });
      continue;
    }
    rows.push({ ...base, expect: 'open', src: 'Karar yok · eski yönlendirme', hint: r.target?.url || r.hint || '' });
  }
  if (traffic) for (const r of rows) { const t = traffic.get(r.path); if (t) r.traffic = trafficOf(t); }
  return { rows: sortByTraffic(rows), map };
}

// ---------- Requests ----------
// request(url) → { status, location }. Same form as the 301 check of the matching screen.
// guard: SSRF check (public mode). Every hop goes through it.
export function makeRequest({ guard = null, timeoutMs = 8000, userAgent = 'SEO-Audit' } = {}) {
  return async (url) => {
    if (guard && await guard(url)) throw Object.assign(new Error('blocked-private'), { cause: { code: 'blocked-private' } });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': userAgent } });
      res.body?.cancel?.();
      return { status: res.status, location: res.headers.get('location') };
    } catch (e) { throw e.name === 'AbortError' ? Object.assign(new Error('timeout'), { cause: { code: 'timeout' } }) : e; }
    finally { clearTimeout(t); }
  };
}

// Follows redirects by hand. Only hosts in `allowed` get a request (the live domains of the project).
// A hop to another host stops the walk: { left: url }. The first address is always the old domain.
async function follow(start, get, allowed, maxHops) {
  const chain = [];
  let url = start;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (hop && !allowed.has(hostKey(url))) return { chain, left: url };
    let res;
    try { res = await get(url); } catch (e) { return { chain, error: e.cause?.code || e.message || 'hata', at: url }; }
    if (res.status >= 300 && res.status < 400 && res.location) {
      chain.push(res.status);
      try { url = new URL(res.location, url).href; } catch { return { chain, error: 'bozuk Location', at: url }; }
      continue;
    }
    return { chain, final: { status: res.status, url } };
  }
  return { chain, loop: true, at: url };
}

// Text of what the live site gave: "301 → 301 → 200" and the last address.
function gotText(f) {
  if (f.error) return { got: `istenemedi (${f.error})`, final: f.at || '' };
  const steps = f.chain.map(String);
  if (f.left) return { got: [...steps, 'başka alan adı'].join(' → '), final: f.left };
  if (f.loop) return { got: [...steps, '…'].join(' → '), final: f.at };
  return { got: [...steps, String(f.final.status)].join(' → '), final: f.chain.length ? f.final.url : '' };
}

// Decides the result kind of one old address. isStg: is a host staging? (makeIsStaging of launch.js)
export function classify(e, f, isStg) {
  if (f.error) return f.error === 'blocked-private' ? 'blocked' : 'error';
  const first = f.chain[0];
  if (!f.chain.length && (f.final.status === 401 || f.final.status === 403)) return 'auth';
  if (e.expect === '410') return !f.chain.length && f.final.status === 410 ? 'ok-410' : 'no410';
  if (!f.chain.length) {
    const st = f.final.status;
    if (e.expect === '301') return st >= 200 && st < 300 ? 'no301-open' : 'no301';
    if (e.expect === '200') return st >= 200 && st < 300 ? 'ok-200' : 'page-gone';
    if (st >= 200 && st < 300) return 'ok-open';
    return e.late && !e.proof ? 'late-unproven' : 'lost';
  }
  // A redirect.
  if (f.left) {
    if (isStg(hostName(f.left))) return 'to-staging';
    // v0.12.2: the expected target is on another domain (an old redirect to an outside address, approved in the map).
    if (e.expect === '301' && e.target && sameUrl(f.left, e.target) && f.chain.length === 1) return [301, 308].includes(first) ? 'ok-left' : 'temp';
    return 'outside';
  }
  if (f.loop) return 'target-bad';
  const st = f.final.status;
  if (st === 401 || st === 403) return 'auth';
  if (!(st >= 200 && st < 300)) return 'target-bad';
  if (e.expect === '301' && !sameUrl(f.final.url, e.target)) return 'wrong-target';
  if (e.expect === '200') return 'moved-page';
  if (f.chain.length > 1) return 'chain';
  if (![301, 308].includes(first)) return 'temp';
  return e.expect === 'open' ? 'ok-open' : 'ok-301';
}

// Checks every expected row on the live site. allowed: live hosts (hostKey form). Returns rows with the result.
export async function checkRedirects(rows, request, { allowed, isStg = () => false, concurrency = 8, maxHops = 5, maxChecks = Infinity } = {}) {
  const memo = new Map(); // one request per address, even when many 301s go to the same target
  const get = (url) => { if (!memo.has(url)) memo.set(url, request(url)); return memo.get(url); };
  const out = new Array(rows.length);
  let i = 0, asked = 0;
  const worker = async () => {
    while (i < rows.length) {
      const n = i++;
      const e = rows[n];
      if (e.noLive) { out[n] = { ...e, kind: 'nolive', got: '', final: '' }; continue; }
      if (asked >= maxChecks) { out[n] = { ...e, kind: 'limit', got: '', final: '' }; continue; }
      asked++;
      const f = await follow(e.oldUrl, get, allowed, maxHops);
      out[n] = { ...e, kind: classify(e, f, isStg), ...gotText(f) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, worker));
  return out;
}

// ---------- B, C, D. Findings of a live crawl ----------
// res: live crawl. oldRes: old crawl (before launch). liveHost: the live domain. isStg: staging hosts of the project.
export function liveFindings({ site, res, oldRes, liveHost, isStg }) {
  const items = [];
  const ok = res.pages.filter(isOk);
  const add = (it) => items.push({ site: site.key, list: [], detail: null, info: false, action: null, listKind: 'page', ...it });

  // B. Staging settings. Normal on staging, critical on the live site.
  const ib = indexBlockers(res);
  if (ib.noindex) add({ group: 'critical', kind: 'live-noindex', team: 'Backend', title: 'Canlıda noindex', unit: 'sayfa', ...ib.noindex,
    note: 'Canlı sayfa Google\'a "dizine ekleme" diyor. Sayfa Google\'dan düşer. noindex etiketini ve X-Robots-Tag başlığını kaldırın.' });
  if (ib.disallow) add({ group: 'critical', kind: 'live-disallow', team: 'Backend', title: 'robots.txt Disallow: /', n: 1, unit: 'bütün site', list: ib.disallow.list,
    note: 'robots.txt bütün siteyi Googlebot\'a kapatıyor. Satırı hemen kaldırın.' });
  const sa = stagingAddresses(res, isStg);
  if (sa.found) add({ group: 'critical', kind: 'live-staging-addr', team: 'CMS', title: 'Sitede staging adresi', unit: 'adres', ...sa.found,
    note: 'Canlı sitede staging alan adı yazılı. Google ve kullanıcı staging\'e gider veya adres kırılır. Göreli adres veya canlı alan adı kullanın.' });

  // C. Tags of the old site.
  const oldOk = oldRes.pages.filter(isOk);
  const tags = tagCheck(oldOk, ok, { heir: site.role === 'heir' });
  for (const t of tags) add({ group: 'fix', team: 'Frontend', ...t, kind: `live-${t.kind}`, title: t.kind === 'gsc' ? 'Search Console doğrulama etiketi' : 'Analytics / GTM etiketi' });

  // D. Sitemap.
  const sm = res.meta.sitemap || {};
  // A file in the list may be a failed try (the crawler also tries /sitemap.xml): only a 200 file counts.
  const files = (sm.files || []).filter((f) => !f.index && f.status === 200);
  const oldHadSitemap = (oldRes.meta.sitemap?.files || []).some((f) => f.status === 200);
  const listed = (res.meta.robots?.sitemaps || []).length > 0;
  const smList = files.map((f) => f.url).join(', ');
  const otherHosts = Object.entries(sm.hosts || {}).filter(([h]) => bare(h) !== bare(liveHost) && !isStg(h));
  if (otherHosts.length) add({ group: 'fix', kind: 'sitemap-host', team: 'CMS', title: 'Sitemap\'te başka alan adı', unit: 'URL',
    n: otherHosts.reduce((a, [, n]) => a + n, 0), list: otherHosts.map(([h, n]) => ({ what: 'sitemap', page: smList, value: `${n} URL · ${h}` })),
    note: 'Sitemap sadece bu sitenin canlı adreslerini içermeli. Başka alan adındaki adresleri çıkarın.' });
  const bad = res.pages.filter((p) => p.inSitemap && !isOk(p));
  if (bad.length) add({ group: 'fix', kind: 'sitemap-status', team: 'CMS', title: 'Sitemap\'te 200 olmayan adres', unit: 'adres', n: bad.length,
    list: bad.map((p) => ({ what: p.redirectChain?.length ? `${p.status} → ${p.finalStatus ?? ''}`.trim() : String(p.status || p.error || 'hata'), page: p.url, value: p.finalUrl && p.finalUrl !== p.url ? p.finalUrl : '' })),
    note: 'Sitemap sadece 200 veren sayfaları içermeli. Yönlenen ve hata veren adresleri çıkarın veya düzeltin.' });
  if (!files.length && (oldHadSitemap || listed)) add({ group: 'fix', kind: 'sitemap-missing', team: 'CMS', title: 'Sitemap bulunamadı', n: 1, unit: '',
    list: (sm.files || []).map((f) => ({ what: 'sitemap', page: f.url, value: String(f.status) })),
    note: listed ? 'robots.txt sitemap adresi veriyor ama dosya açılmıyor. Dosyayı düzeltin ve Search Console\'a gönderin.'
      : 'Eski sitede sitemap vardı. Canlı sitede sitemap açılmıyor. Sitemap ekleyin ve Search Console\'a gönderin.' });

  // What is fine on this site: a short ok line for each check that found nothing.
  const has = (k) => items.some((x) => x.kind === k);
  if (!ib.noindex && !ib.disallow && !sa.found) add({ group: 'ok', kind: 'live-clean', team: '', title: 'Staging ayarı kalmadı', n: 0, unit: '', note: 'noindex, Disallow ve staging adresi yok.' });
  if (hasTagData(oldOk) && hasTagData(ok) && !tags.length && union(oldOk).size) add({ group: 'ok', kind: 'live-tags', team: '', title: 'Etiketler var', n: 0, unit: '', note: 'Eski sitenin etiketleri canlı sitede var.' });
  if (files.length && !has('sitemap-host') && !has('sitemap-status')) add({ group: 'ok', kind: 'live-sitemap', team: '', title: 'Sitemap doğru', n: 0, unit: '', note: 'Sitemap sadece canlı adresleri içeriyor. Adresler 200 veriyor.' });
  return items;
}
const union = (pages) => new Set(pages.flatMap((p) => [...(p.tracking || []), ...(p.gscVerify || [])]));

// ---------- The result ----------
// checked: rows from checkRedirects. liveSites: [{ key, role, name, liveOrigin, state, res }] (heir first).
// state: done (res is the live crawl), none, running, deleted, stale (crawled on another domain).
export function buildVerify({ checked, liveSites, oldRes, isStg, cfg = {} }) {
  const vc = cfg.verify || {};
  const items = [];
  const add = (it) => items.push({ site: null, team: '', note: '', n: 0, unit: '', info: false, detail: null, list: [], action: null, listKind: 'page', ...it });
  const oldHost = bare(oldRes.meta.host);

  // A. One item per result kind. Rows of a site without a live domain go to that site's item.
  const byKind = new Map();
  for (const r of checked) {
    if (r.kind === 'nolive') continue;
    (byKind.get(r.kind) || byKind.set(r.kind, []).get(r.kind)).push(r);
  }
  const expectText = (r) => (r.expect === '301' ? r.target || '' : r.expect === '410' ? '410' : r.expect === '200' ? '200 (aynı adres)' : `Karar yok${r.hint ? ` · öneri: ${r.hint}` : ''}`);
  for (const kind of ORDER) {
    const list = byKind.get(kind);
    if (!list) continue;
    const [group, title, note] = R[kind];
    add({ group, kind, site: 'server', team: group === 'ok' ? '' : 'Backend', title, note, n: list.length, unit: 'adres', listKind: 'redirect',
      list: sortByTraffic(list).map((r) => ({ old: r.oldUrl, expect: expectText(r), got: r.got, final: r.final, src: r.src, type: r.expect, ...(r.traffic ? { traffic: r.traffic } : {}) })) });
  }

  // Sites: a card for each, and the work that blocks the check.
  const cards = [];
  for (const s of liveSites) {
    const card = { key: s.key, role: s.role, name: s.name || '', liveHost: s.liveOrigin ? hostKey(s.liveOrigin) : '', state: s.liveOrigin ? s.state : 'nolive',
      pages: s.res ? s.res.pages.filter(isOk).length : 0, startedAt: s.res?.meta.startedAt || s.startedAt || null, jobId: s.jobId || null, done: s.done || 0 };
    cards.push(card);
    const rows = checked.filter((r) => r.kind === 'nolive' && r.site === s.key);
    if (!s.liveOrigin) {
      add({ group: 'unknown', kind: 'nolive', site: s.key, team: 'Siz', title: 'Canlı alan adı yok', n: rows.length, unit: 'adres', listKind: 'redirect', action: { type: 'project', site: s.key },
        note: 'Projede bu sitenin canlı alan adı yok. 301 listesi ve canlı site kontrol edilemez. Proje adımında canlı alan adını yazın.',
        list: sortByTraffic(rows).map((r) => ({ old: r.oldUrl, expect: 'Canlı alan adı yok', got: '', final: '', src: r.src, type: r.expect, ...(r.traffic ? { traffic: r.traffic } : {}) })) });
      continue;
    }
    if (s.state === 'done' && s.res) { items.push(...liveFindings({ site: s, res: s.res, oldRes, liveHost: hostName(s.liveOrigin), isStg }).map((x) => ({ team: '', note: '', n: 0, unit: '', ...x }))); continue; }
    const why = { none: ['live-nocrawl', 'Canlıda taranmadı', 'Staging ayarı, etiket ve sitemap kontrolü için canlı tarama gerekli. Siteyi canlıda tarayın.'],
      deleted: ['live-nocrawl', 'Canlı tarama silinmiş', 'Canlı taramanın dosyası yok. Siteyi canlıda tekrar tarayın.'],
      stale: ['live-stale', 'Canlı tarama eski alan adında', 'Canlı alan adı değişti. Tarama eski alan adına ait. Siteyi canlıda tekrar tarayın.'],
      running: ['live-running', 'Canlı tarama sürüyor', 'Tarama bitince staging ayarı, etiket ve sitemap sonucu gelir.'] }[s.state] || null;
    if (why) add({ group: 'unknown', kind: why[0], site: s.key, team: 'Siz', title: why[1], note: why[2], n: 0, unit: '',
      action: s.state === 'running' ? { type: 'watch', jobId: s.jobId } : { type: 'crawl-live', site: s.key } });
  }
  // C needs tag data in the old crawl. The old crawl is locked after launch: say so, do not ask for a new crawl.
  if (!hasTagData(oldRes.pages.filter(isOk)) && oldRes.pages.some(isOk)) {
    add({ group: 'unknown', kind: 'old-tags', site: 'old', team: 'Siz', title: 'Etiket kontrolü yapılamadı',
      note: 'Eski site taraması v0.10.0\'dan önce yapıldı. Etiket verisi yok. Çıkıştan sonra eski site tekrar taranamaz: etiketleri elle karşılaştırın.' });
  }

  // The old domain may still serve the old site (DNS not switched yet): most 301 rows answer 200 without a redirect.
  const want301 = checked.filter((r) => r.expect === '301' && !['nolive', 'limit', 'error', 'auth', 'outside', 'blocked'].includes(r.kind));
  const open200 = want301.filter((r) => r.kind === 'no301-open').length;
  const notSwitched = want301.length >= (vc.notSwitchedMin ?? 3) && open200 / want301.length >= (vc.notSwitchedRatio ?? 0.8);

  const groups = VERIFY_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) }));
  const counts = Object.fromEntries(VERIFY_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key && !i.info && (g.key !== 'unknown' || i.kind !== 'live-running')).length]));
  delete counts.ok;
  const redirects = { total: checked.length, critical: 0, fix: 0, unknown: 0, ok: 0 };
  for (const r of checked) redirects[r.kind === 'nolive' ? 'unknown' : R[r.kind][0]]++;
  return { groups, counts, total: counts.critical + counts.fix + counts.unknown, redirects, sites: cards, notSwitched, oldHost,
    listLimit: vc.listLimit ?? 200 };
}
