// Launch list (v0.10.0, Sprint 3 Part 3a). Reads the staging crawls of a project and lists the work before go-live.
// Groups by time: critical (fix before launch), decide (the 301 map), switch (change at launch: normal on staging),
// check (compare with the old site). A site crawled on its live domain is not staging: its checks come in Part 3b.
import robotsParser from 'robots-parser';
import { isOk, isNoindex, isStagingHost } from './rules/helpers.js';

const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const NOINDEX = /noindex|none/;

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
  const liveHosts = new Set(info.map((x) => x.liveHost).filter(Boolean));
  const stagingHosts = new Set(info.filter((x) => x.staging).map((x) => x.host));
  const isStg = (h) => {
    const b = bare(h);
    if (!b || liveHosts.has(b)) return false;
    return stagingHosts.has(b) || (cfg.stagingHosts ? isStagingHost(b, cfg) : false);
  };

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
    const ok = res.pages.filter(isOk);
    const fresh = ok.some((p) => p.absHosts) && !!res.meta.sitemap?.hosts;
    const blocked = rootBlocked(res);
    const noindex = ok.filter(isNoindex);
    const open = ok.filter((p) => !isNoindex(p));

    // Critical: staging is open to Google (no password, no noindex, no Disallow).
    if (!res.meta.options?.auth && !blocked && open.length) {
      add({ group: 'critical', kind: 'staging-open', site: s.key, team: 'Backend', title: 'Staging Google\'a açık', n: open.length, unit: 'sayfa',
        note: 'Staging şifresiz. noindex ve Disallow yok. Google sayfaları dizine ekleyebilir. Şifre veya noindex ekleyin.',
        list: open.map((p) => ({ what: 'açık', page: p.url, value: '' })) });
    }

    // Critical: the staging address is written in full on the site. It breaks after launch.
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
    if (list.length) {
      const detail = {};
      for (const x of list) detail[x.what] = (detail[x.what] || 0) + (x.count || 1);
      const n = Object.values(detail).reduce((a, b) => a + b, 0);
      const order = Object.keys(STAGE_KIND);
      list.sort((a, b) => order.indexOf(a.what) - order.indexOf(b.what));
      add({ group: 'critical', kind: 'staging-addr', site: s.key, team: 'CMS', title: 'Sitede staging adresi yazılı', n, unit: 'adres', detail, list: list.map(({ count, ...x }) => ({ ...x, what: STAGE_KIND[x.what] })),
        note: 'Staging alan adı açık yazılmış. Canlıdan sonra bu adresler staging\'e gider veya kırılır. Göreli adres veya canlı alan adı kullanın.' });
    }
    if (!fresh) {
      add({ group: 'check', kind: 'recrawl', site: s.key, team: 'Siz', title: 'Tarama eski', n: 1, unit: '',
        note: 'Bu tarama staging adresi, sitemap ve etiket verisini içermiyor. Siteyi tekrar tarayın.', action: { type: 'recrawl', site: s.key } });
    }

    // Switch at launch: normal on staging, wrong on the live site.
    if (noindex.length) {
      const meta = noindex.filter((p) => NOINDEX.test(String(p.metaRobots || '').toLowerCase())).length;
      const head = noindex.filter((p) => NOINDEX.test(String(p.xRobotsTag || '').toLowerCase())).length;
      add({ group: 'switch', kind: 'noindex', site: s.key, team: 'Backend', title: 'noindex', n: noindex.length, unit: 'sayfa', detail: { meta, header: head },
        note: 'Canlıya çıkışta noindex etiketini ve X-Robots-Tag başlığını kaldırın.',
        list: noindex.map((p) => ({ what: [p.metaRobots && 'meta robots', p.xRobotsTag && 'X-Robots-Tag'].filter(Boolean).join(', '), page: p.url, value: [p.metaRobots, p.xRobotsTag].filter(Boolean).join(' · ') })) });
    }
    if (blocked) {
      add({ group: 'switch', kind: 'disallow', site: s.key, team: 'Backend', title: 'robots.txt Disallow: /', n: 1, unit: 'bütün site',
        note: 'robots.txt bütün siteyi Googlebot\'a kapatıyor. Canlıya çıkışta bu satırı kaldırın.', list: [{ what: 'robots.txt', page: `${new URL(res.meta.startUrl).origin}/robots.txt`, value: 'Disallow: /' }] });
    }
  }

  // ---- Decide: open rows of the 301 map ----
  const open = (map?.rows || []).filter((r) => r.status === 'pending' || r.status === 'none');
  if (open.length) {
    add({ group: 'decide', kind: 'map-pending', team: 'Siz', title: '301 haritasında karar bekleyen satır', n: open.length, unit: 'satır',
      note: 'Karar yoksa sayfa canlıda 404 verir.', action: { type: 'map' },
      list: open.map((r) => ({ what: r.status === 'pending' ? 'Onay bekliyor' : 'Öneri yok', page: r.oldUrl, value: r.target?.url || '' })) });
  }

  // ---- Check: tags of the old site ----
  const oldOk = oldRes.pages.filter(isOk);
  const oldFresh = oldOk.some((p) => Array.isArray(p.tracking));
  if (!oldFresh && oldOk.length) {
    add({ group: 'check', kind: 'recrawl', site: 'old', team: 'Siz', title: 'Tarama eski', n: 1, unit: '',
      note: 'Eski site taraması etiket verisini içermiyor. Analytics ve Search Console kontrolü için eski siteyi tekrar tarayın.', action: { type: 'recrawl', site: 'old' } });
  }
  const union = (pages, f) => new Set(pages.flatMap((p) => p[f] || []));
  const oldIds = union(oldOk, 'tracking'), oldVer = union(oldOk, 'gscVerify');
  for (const s of sites) {
    const ok = s.res.pages.filter(isOk);
    if (!oldFresh || !ok.some((p) => Array.isArray(p.tracking))) continue;
    const ids = union(ok, 'tracking');
    const missing = [...oldIds].filter((x) => !ids.has(x));
    if (oldIds.size && missing.length) {
      const none = !ids.size;
      add({ group: 'check', kind: 'tracking', site: s.key, team: 'Frontend', title: 'Analytics / GTM etiketi', n: none ? missing.length : 0, unit: none ? 'eksik' : 'farklı', info: !none,
        note: none ? `Eski site: ${[...oldIds].join(', ')}. Yeni site: yok. Etiketi ekleyin.`
          : `Eski site: ${[...oldIds].join(', ')}. Yeni site: ${[...ids].join(', ')}. Yeni hesap bilinçli olabilir. Kontrol edin.`,
        list: missing.map((x) => ({ what: 'eksik kimlik', page: '', value: x })) });
    }
    // Search Console: only the heir. It takes the old domain, so the old verification must stay.
    if (s.role === 'heir' && oldVer.size) {
      const ver = union(ok, 'gscVerify');
      if (![...oldVer].some((x) => ver.has(x))) {
        const none = !ver.size;
        add({ group: 'check', kind: 'gsc', site: s.key, team: 'Frontend', title: 'Search Console doğrulama etiketi', n: none ? 1 : 0, unit: none ? 'eksik' : 'farklı', info: !none,
          note: none ? 'Eski sitede var, yeni sitede yok. DNS ile doğruladıysanız iş yok.' : 'Yeni sitede başka bir doğrulama değeri var. Mülk değişmiş olabilir. Kontrol edin.',
          list: [...oldVer].map((x) => ({ what: 'eski değer', page: '', value: x })) });
      }
    }
  }

  const groups = LAUNCH_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) }));
  const counts = Object.fromEntries(LAUNCH_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key && !i.info).length]));
  return { groups, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), sites: info, listLimit: lc.listLimit ?? 200 };
}
