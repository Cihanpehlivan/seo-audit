// Launch list (v0.10.0, Sprint 3 Part 3a). Reads the staging crawls of a project and lists the work before go-live.
// Groups by time: critical (fix before launch), decide (the 301 map), switch (change at launch: normal on staging),
// check (compare with the old site). A site crawled on its live domain is not staging: its checks are in the live check
// (v0.11.0, src/verify.js), which uses the shared functions below.
import robotsParser from 'robots-parser';
import { isOk, isNoindex, isStagingHost, blocksIndex } from './rules/helpers.js';
import { sortByTraffic } from './urllist.js';

const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

export const LAUNCH_GROUPS = [
  { key: 'critical', title: 'Kritik: çıkıştan önce düzeltin' },
  { key: 'decide', title: 'Karar bekleyen' },
  { key: 'switch', title: 'Çıkış anında değiştirin', sub: 'Staging\'de normal' },
  { key: 'check', title: 'Kontrol edin', sub: 'Eski site ile karşılaştırma' },
];
const STAGE_KIND = { canonical: 'canonical', hreflang: 'hreflang', link: 'link', asset: 'görsel, script, CSS', sitemap: 'sitemap', robots: 'robots.txt Sitemap satırı' };

// Is robots.txt closing the whole site to Googlebot?
export function rootBlocked(res) {
  const r = res.meta.robots;
  if (!r || r.status !== 200 || !r.body) return false;
  const origin = new URL(res.meta.startUrl).origin;
  return robotsParser(`${origin}/robots.txt`, r.body).isAllowed(`${origin}/`, 'Googlebot') === false;
}

// Which hosts are staging? info: [{ host, liveHost, staging }] of the target sites. Live hosts are never staging.
// v0.11.0: shared with the live check (src/verify.js).
export function makeIsStaging(info, cfg = {}) {
  const liveHosts = new Set(info.map((x) => x.liveHost).filter(Boolean));
  const stagingHosts = new Set(info.filter((x) => x.staging).map((x) => x.host));
  return (h) => {
    const b = bare(h);
    if (!b || liveHosts.has(b)) return false;
    return stagingHosts.has(b) || (cfg.stagingHosts ? isStagingHost(b, cfg) : false);
  };
}

// Staging addresses written in full on a site (canonical, hreflang, link, asset, sitemap, robots.txt Sitemap line).
// fresh: the crawl has the data (v0.10.0+). Returns null when there is nothing to report.
export function stagingAddresses(res, isStg) {
  const ok = res.pages.filter(isOk);
  const fresh = ok.some((p) => p.absHosts) && !!res.meta.sitemap?.hosts;
  const list = [];
  if (fresh) {
    for (const p of ok) {
      const a = p.absHosts;
      if (isStg(a.canonical)) list.push({ what: 'canonical', page: p.url, value: p.canonical });
      const hl = (p.hreflang || []).filter((h) => isStg(hostOf(h.url)));
      if (a.hreflang.some(isStg) && hl.length) for (const h of hl) list.push({ what: 'hreflang', page: p.url, value: `${h.lang} → ${h.url}` });
      const lh = a.link.filter(isStg);
      if (lh.length) list.push({ what: 'link', page: p.url, value: lh.join(', ') });
      const ah = a.asset.filter(isStg);
      if (ah.length) list.push({ what: 'asset', page: p.url, value: ah.join(', ') });
    }
    const smFiles = (res.meta.sitemap.files || []).filter((f) => !f.index).map((f) => f.url).join(', ');
    for (const [h, n] of Object.entries(res.meta.sitemap.hosts)) if (isStg(h)) list.push({ what: 'sitemap', page: smFiles, value: `${n} URL · ${h}`, count: n });
  }
  for (const u of res.meta.robots?.sitemaps || []) if (isStg(hostOf(u))) list.push({ what: 'robots', page: `${new URL(res.meta.startUrl).origin}/robots.txt`, value: `Sitemap: ${u}` });
  if (!list.length) return { fresh, found: null };
  const detail = {};
  for (const x of list) detail[x.what] = (detail[x.what] || 0) + (x.count || 1);
  const order = Object.keys(STAGE_KIND);
  list.sort((a, b) => order.indexOf(a.what) - order.indexOf(b.what));
  return { fresh, found: { n: Object.values(detail).reduce((a, b) => a + b, 0), detail, list: list.map(({ count, ...x }) => ({ ...x, what: STAGE_KIND[x.what] })) } };
}

// Settings that close a site to Google: noindex (meta robots, X-Robots-Tag) and robots.txt "Disallow: /".
export function indexBlockers(res) {
  const ok = res.pages.filter(isOk);
  const noindex = ok.filter(isNoindex);
  const robotsUrl = `${new URL(res.meta.startUrl).origin}/robots.txt`;
  return {
    open: ok.filter((p) => !isNoindex(p)),
    noindex: noindex.length ? {
      n: noindex.length,
      detail: { meta: noindex.filter((p) => blocksIndex(p.metaRobots)).length, header: noindex.filter((p) => blocksIndex(p.xRobotsTag)).length },
      list: noindex.map((p) => ({ what: [p.metaRobots && 'meta robots', p.xRobotsTag && 'X-Robots-Tag'].filter(Boolean).join(', '), page: p.url, value: [p.metaRobots, p.xRobotsTag].filter(Boolean).join(' · ') })),
    } : null,
    disallow: rootBlocked(res) ? { list: [{ what: 'robots.txt', page: robotsUrl, value: 'Disallow: /' }] } : null,
  };
}

// Tags of the old site on a new site: Analytics/GTM IDs and (heir only) the Search Console meta tag.
// Returns [] when a crawl has no tag data. Each item: { kind, n, unit, info, note, list }.
const union = (pages, f) => new Set(pages.flatMap((p) => p[f] || []));
export const hasTagData = (ok) => ok.some((p) => Array.isArray(p.tracking));
export function tagCheck(oldOk, ok, { heir = false } = {}) {
  if (!hasTagData(oldOk) || !hasTagData(ok)) return [];
  const out = [];
  const oldIds = union(oldOk, 'tracking'), oldVer = union(oldOk, 'gscVerify');
  const ids = union(ok, 'tracking');
  const missing = [...oldIds].filter((x) => !ids.has(x));
  if (oldIds.size && missing.length) {
    const none = !ids.size;
    out.push({ kind: 'tracking', n: none ? missing.length : 0, unit: none ? 'eksik' : 'farklı', info: !none,
      note: none ? `Eski site: ${[...oldIds].join(', ')}. Yeni site: yok. Etiketi ekleyin.`
        : `Eski site: ${[...oldIds].join(', ')}. Yeni site: ${[...ids].join(', ')}. Yeni hesap bilinçli olabilir. Kontrol edin.`,
      list: missing.map((x) => ({ what: 'eksik kimlik', page: '', value: x })) });
  }
  // Search Console: only the heir. It takes the old domain, so the old verification must stay.
  if (heir && oldVer.size) {
    const ver = union(ok, 'gscVerify');
    if (![...oldVer].some((x) => ver.has(x))) {
      const none = !ver.size;
      out.push({ kind: 'gsc', n: none ? 1 : 0, unit: none ? 'eksik' : 'farklı', info: !none,
        note: none ? 'Eski sitede var, yeni sitede yok. DNS ile doğruladıysanız iş yok.' : 'Yeni sitede başka bir doğrulama değeri var. Mülk değişmiş olabilir. Kontrol edin.',
        list: [...oldVer].map((x) => ({ what: 'eski değer', page: '', value: x })) });
    }
  }
  return out;
}

// oldRes: crawl of the old site. sites: target sites, heir first: { key, role, res, liveOrigin }.
// map: 301 map (rows, noLive). cfg: the whole rules.json (staging patterns and the launch section).
export function buildLaunch({ oldRes, sites, map, cfg = {} }) {
  const lc = cfg.launch || {};
  const items = [];
  const add = (it) => items.push({ site: null, team: '', note: '', n: 0, unit: '', info: false, detail: null, list: [], action: null, ...it });

  // Which sites are staging? A site is staging when its crawl host is not its live host. No live domain: staging.
  const info = sites.map((s) => {
    const host = bare(s.res.meta.host), liveHost = s.liveOrigin ? bare(hostOf(s.liveOrigin)) : '';
    return { key: s.key, role: s.role, host, liveHost, staging: !liveHost || host !== liveHost };
  });
  const isStg = makeIsStaging(info, cfg);

  // ---- Critical: staging addresses in the 301 list ----
  const noLive = new Set(map?.noLive || []);
  const bySite = new Map();
  for (const r of map?.rows || []) {
    if (!['rule', 'approved'].includes(r.status) || !r.target?.url || !isStg(hostOf(r.target.url))) continue;
    const k = r.target.site || '';
    (bySite.get(k) || bySite.set(k, []).get(k)).push({ what: '301', page: r.oldUrl, value: r.target.url });
  }
  for (const [k, list] of bySite) {
    const fixLive = k && noLive.has(k);
    add({ group: 'critical', kind: 'map-staging', site: k || null, team: 'Siz', title: '301 listesinde staging adresi', n: list.length, unit: 'satır', list,
      note: fixLive ? 'Hedef staging adresi. Canlıda bu adres çalışmaz. Canlı alan adını projeye yazın.' : 'Hedef staging adresi. Haritada hedefi canlı alan adı ile yazın.',
      action: fixLive ? { type: 'project', site: k } : { type: 'map' } });
  }

  // ---- Per staging site ----
  for (const s of sites) {
    const me = info.find((x) => x.key === s.key);
    if (!me.staging) continue;
    const res = s.res;
    const ib = indexBlockers(res);

    // Critical: staging is open to Google (no password, no noindex, no Disallow).
    if (!res.meta.options?.auth && !ib.disallow && ib.open.length) {
      add({ group: 'critical', kind: 'staging-open', site: s.key, team: 'Backend', title: 'Staging Google\'a açık', n: ib.open.length, unit: 'sayfa',
        note: 'Staging şifresiz. noindex ve Disallow yok. Google sayfaları dizine ekleyebilir. Şifre veya noindex ekleyin.',
        list: ib.open.map((p) => ({ what: 'açık', page: p.url, value: '' })) });
    }

    // Critical: the staging address is written in full on the site. It breaks after launch.
    const sa = stagingAddresses(res, isStg);
    if (sa.found) {
      add({ group: 'critical', kind: 'staging-addr', site: s.key, team: 'CMS', title: 'Sitede staging adresi yazılı', unit: 'adres', ...sa.found,
        note: 'Staging alan adı açık yazılmış. Canlıdan sonra bu adresler staging\'e gider veya kırılır. Göreli adres veya canlı alan adı kullanın.' });
    }
    if (!sa.fresh) {
      add({ group: 'check', kind: 'recrawl', site: s.key, team: 'Siz', title: 'Tarama eski', n: 1, unit: '',
        note: 'Bu tarama staging adresi, sitemap ve etiket verisini içermiyor. Siteyi tekrar tarayın.', action: { type: 'recrawl', site: s.key } });
    }

    // Switch at launch: normal on staging, wrong on the live site.
    if (ib.noindex) {
      add({ group: 'switch', kind: 'noindex', site: s.key, team: 'Backend', title: 'noindex', unit: 'sayfa', ...ib.noindex,
        note: 'Canlıya çıkışta noindex etiketini ve X-Robots-Tag başlığını kaldırın.' });
    }
    if (ib.disallow) {
      add({ group: 'switch', kind: 'disallow', site: s.key, team: 'Backend', title: 'robots.txt Disallow: /', n: 1, unit: 'bütün site',
        note: 'robots.txt bütün siteyi Googlebot\'a kapatıyor. Canlıya çıkışta bu satırı kaldırın.', list: ib.disallow.list });
    }
  }

  // ---- Decide: open rows of the 301 map ----
  // v0.12.1: traffic order (the old address list). A row without an open decision and more traffic comes first,
  // "Onay bekliyor" and "Öneri yok" mixed. Rows without traffic keep the map order at the end.
  const open = sortByTraffic((map?.rows || []).filter((r) => r.status === 'pending' || r.status === 'none'));
  if (open.length) {
    add({ group: 'decide', kind: 'map-pending', team: 'Siz', title: '301 haritasında karar bekleyen satır', n: open.length, unit: 'satır',
      note: 'Karar yoksa sayfa canlıda 404 verir.', action: { type: 'map' },
      list: open.map((r) => ({ what: r.status === 'pending' ? 'Onay bekliyor' : 'Öneri yok', page: r.oldUrl, value: r.target?.url || '', ...(r.traffic ? { traffic: r.traffic } : {}) })) });
  }

  // ---- Check: tags of the old site ----
  const oldOk = oldRes.pages.filter(isOk);
  if (!hasTagData(oldOk) && oldOk.length) {
    add({ group: 'check', kind: 'recrawl', site: 'old', team: 'Siz', title: 'Tarama eski', n: 1, unit: '',
      note: 'Eski site taraması etiket verisini içermiyor. Analytics ve Search Console kontrolü için eski siteyi tekrar tarayın.', action: { type: 'recrawl', site: 'old' } });
  }
  for (const s of sites) {
    for (const t of tagCheck(oldOk, s.res.pages.filter(isOk), { heir: s.role === 'heir' })) {
      add({ group: 'check', site: s.key, team: 'Frontend', title: t.kind === 'gsc' ? 'Search Console doğrulama etiketi' : 'Analytics / GTM etiketi', ...t });
    }
  }

  const groups = LAUNCH_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) }));
  const counts = Object.fromEntries(LAUNCH_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key && !i.info).length]));
  return { groups, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), sites: info, listLimit: lc.listLimit ?? 200 };
}
