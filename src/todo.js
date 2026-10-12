// Work list by place (v0.9.0). Every task goes to the place where the work is done:
// the server of the old domain (301, fixes, 410), each new site (create a page, add a link),
// content (title, meta, H1, noindex) and decisions (the user).
// A site with too few pages is "not ready": its tasks are held and not counted, because they are not real work yet.
import { FIX } from './compare.js';

const TASK = {
  '301': '301 kurun',
  fix: 'Yönlendirmeyi düzeltin',
  '410': '410 verin',
  create: 'Sayfa oluşturun',
  link: 'Sayfaya link verin',
  title: 'Title boşaldı',
  meta: 'Meta açıklama boşaldı',
  h1: 'H1 boşaldı',
  noindex: 'noindex eklendi',
  map: '301 haritasında karar bekleyen sayfa',
  section: 'Bölüm kararı yanlış olabilir',
  unknown: 'Kontrol edilemedi',
};
const ORDER = { server: ['301', 'fix', '410'], site: ['create', 'link'], content: ['meta', 'title', 'h1', 'noindex'], decide: ['map', 'section', 'unknown'] };
export const TODO_TASKS = TASK;

const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const redirectFix = (r) => (r.hops > 1 ? `Zincir ${r.hops} adım. Tek adımlı 301 yapın.` : r.status && ![301, 308].includes(r.status) ? `${r.status} geçici yönlendirmedir. 301 kullanın.` : '');

// Is a target site ready? A site is "thin" when it has far fewer pages than the old pages that go to it.
// Then most of its "missing pages" are only pages not entered yet. The user can accept the site (readyOk = crawl id).
export function siteReadiness(cmp, sites, readyOk = {}, cfg = {}) {
  const ratio = cfg.notReadyRatio ?? 0.3, minOld = cfg.notReadyMinOld ?? 10;
  const keyOfHost = (h) => sites.find((s) => bare(s.host) === bare(h))?.key;
  const old = Object.fromEntries(sites.map((s) => [s.key, 0]));
  const R = cmp.rows;
  // Old pages expected on each site. Pages of a removed section are not expected anywhere.
  for (const k of ['lost', 'redirected', 'changed', 'unlinked', 'unknown', 'moved', 'no301', 'notarget']) {
    for (const r of R[k] || []) { const key = keyOfHost(r.site); if (key) old[key]++; }
  }
  if (sites[0]) old[sites[0].key] += R.same || 0; // "same" = same path on the heir
  const out = {};
  for (const s of sites) {
    const thin = old[s.key] >= minOld && s.okPages < old[s.key] * ratio;
    const acked = thin && !!s.crawlId && readyOk[s.key] === s.crawlId;
    out[s.key] = { state: !thin ? 'ok' : acked ? 'accepted' : 'thin', oldPages: old[s.key], newPages: s.okPages };
  }
  return out;
}

// cmp: comparison with probe. map: 301 map. sections: section table (alerts). sites: target sites, heir first
// ({ key, role, name, host, okPages, crawlId }). oldHost: host of the old site (its server gets the 301s).
export function buildTodo({ cmp, map, sections = [], sites, oldHost, readyOk = {}, cfg = {} }) {
  const R = cmp.rows;
  const keyOfHost = (h) => sites.find((s) => bare(s.host) === bare(h))?.key || null;
  const ready = siteReadiness(cmp, sites, readyOk, cfg);
  const items = [];
  const add = (place, task, row, extra = {}) => items.push({
    place, task, label: TASK[task], path: row.path || '', oldUrl: row.oldUrl || '', newUrl: '', site: null, note: '', ...extra,
  });
  const mapRow = new Map((map?.rows || []).map((r) => [r.path, r]));

  // Server of the old domain: the final 301 list (as in the CSV) minus the 301s that already work.
  const cmpNo301 = new Map((R.no301 || []).map((r) => [r.path, r]));
  for (const r of map?.rows || []) {
    if (r.status === 'rule' && !r.installed) add('server', '301', r, { newUrl: r.target.url, site: r.target.site, note: cmpNo301.get(r.path)?.todo || r.why });
    if (r.status === 'approved') add('server', '301', r, { newUrl: r.target.url, site: r.target.site, note: r.decision?.src === 'elle' ? 'Haritada elle yazıldı.' : 'Haritada onaylandı.' });
    if (r.status === 'gone') add('server', '410', r, { note: 'Haritada 410 seçildi.' });
  }
  for (const r of R.redirected || []) {
    const fix = !r.targetBroken && redirectFix(r);
    if (fix) add('server', 'fix', r, { newUrl: r.target, site: keyOfHost(r.site), note: fix });
  }
  for (const r of R.moved || []) {
    const fix = redirectFix(r);
    if (fix) add('server', 'fix', r, { newUrl: r.newUrl || r.expectUrl, site: keyOfHost(r.site), note: fix });
  }

  // New sites: a missing target page (rule target or a target chosen in the map), a page without links.
  for (const r of R.notarget || []) {
    const m = mapRow.get(r.path);
    if (m && !['pending', 'none'].includes(m.status)) continue; // a decision replaced the rule target
    add('site', 'create', r, { newUrl: r.expectUrl || r.checkUrl, site: keyOfHost(r.site), note: r.todo });
  }
  for (const r of map?.rows || []) {
    if (r.status === 'approved' && r.target?.site && r.warn && sites.some((s) => s.key === r.target.site)) {
      add('site', 'create', r, { newUrl: r.target.url, site: r.target.site, note: 'Haritada seçilen hedef sayfa son taramada yok.' });
    }
  }
  for (const r of R.unlinked || []) add('site', 'link', r, { newUrl: r.newUrl, site: keyOfHost(r.site), note: r.todo });
  for (const r of R.moved || []) if (r.targetUnlinked) add('site', 'link', r, { newUrl: r.newUrl, site: keyOfHost(r.site), note: 'Hedef sayfaya yeni sitede link verin.' });

  // Content: one task per lost field.
  for (const r of [...(R.changed || []), ...(R.moved || [])]) {
    for (const c of (r.changes || []).filter((x) => x.kind === 'lost')) {
      add('content', c.field, r, { newUrl: r.newUrl || '', site: keyOfHost(r.site), note: FIX[c.field] || '' });
    }
  }

  // Decisions: open rows of the 301 map, probably wrong section decisions, pages that could not be checked.
  const created = new Set(items.filter((x) => x.task === 'create').map((x) => x.path));
  const cmpSite = new Map();
  for (const k of ['lost', 'notarget', 'removed', 'redirected']) for (const r of R[k] || []) cmpSite.set(r.path, keyOfHost(r.site));
  for (const r of map?.rows || []) {
    if (r.status === 'pending' && !created.has(r.path)) add('decide', 'map', r, { newUrl: r.target.url, site: r.from === 'removed' ? null : cmpSite.get(r.path) || null, note: `Öneri onay bekliyor: ${r.target.url}` });
    if (r.status === 'none' && !created.has(r.path)) add('decide', 'map', r, { site: r.from === 'removed' ? null : cmpSite.get(r.path) || null, note: 'Öneri yok. Adres seçin veya 410 verin.' });
    if (r.status === 'approved' && r.warn && !sites.some((s) => s.key === r.target?.site) && r.target?.site) add('decide', 'map', r, { note: r.warn });
  }
  for (const s of sections.filter((x) => x.alert)) add('decide', 'section', { path: s.from }, { note: 'Eşleştirme ekranında önerilen seçimi kullanın.' });
  for (const r of R.unknown || []) add('decide', 'unknown', r, { newUrl: r.checkUrl || '', site: keyOfHost(r.site), note: [r.reason, r.todo].filter(Boolean).join('. ') });

  // A task of a thin site waits. Server tasks never wait: the 301 list does not depend on the new site's content.
  for (const it of items) it.held = it.place !== 'server' && !!it.site && ready[it.site]?.state === 'thin';

  const count = (list) => {
    const c = {};
    for (const it of list) c[it.task] = (c[it.task] || 0) + 1;
    return c;
  };
  const tasks = (kind, list) => ORDER[kind].map((t) => ({ kind: t, label: TASK[t], n: count(list)[t] || 0 })).filter((t) => t.n);
  const live = items.filter((x) => !x.held);
  const places = [];
  const server = live.filter((x) => x.place === 'server');
  places.push({ key: 'server', kind: 'server', title: `${bare(oldHost)} sunucusu`, team: 'Backend', tasks: tasks('server', server), n: server.length });
  for (const s of sites) {
    const mine = live.filter((x) => x.place === 'site' && x.site === s.key);
    const held = items.filter((x) => x.held && x.site === s.key).length;
    places.push({ key: `site:${s.key}`, kind: 'site', site: s.key, title: bare(s.host), role: s.role, name: s.name || '', team: 'CMS',
      tasks: tasks('site', mine), n: mine.length, held, ready: ready[s.key] });
  }
  const content = live.filter((x) => x.place === 'content');
  places.push({ key: 'content', kind: 'content', title: 'İçerik', team: 'İçerik', tasks: tasks('content', content), n: content.length });
  const decide = live.filter((x) => x.place === 'decide');
  places.push({ key: 'decide', kind: 'decide', title: 'Karar bekleyen', team: 'Siz', tasks: tasks('decide', decide), n: decide.length });

  const placeOf = (it) => (it.place === 'site' ? `site:${it.site}` : it.place);
  for (const it of items) it.placeKey = placeOf(it);
  return { places, items, ready, total: live.length, held: items.length - live.length, listLimit: cfg.listLimit ?? 200 };
}
