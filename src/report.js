// Shareable report (v0.14.0). One self-contained HTML file for the client or the team. The server makes it on each
// request and does not save it (client data stays out of the repository and off the disk).
// Two steps: a model (plain data, tested) and the HTML. The HTML has no script: a Content-Security-Policy meta tag and
// the response header block every script, so a text that escaped esc() still cannot run.
// Teams: the screens use Backend, CMS, İçerik, Siz, Frontend, SEO. The report uses four teams (rules.json → report.teams).
import { SEVERITY } from './rules/index.js';
import { TODO_TASKS } from './todo.js';

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const REPORT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': REPORT_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};
export const AUDIENCES = ['musteri', 'ekip'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('tr-TR');
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const day = (d) => { const x = new Date(d); return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
const sevRank = (s) => SEVERITY[s]?.rank ?? 9;

// The report name of a team. Unknown or empty team: "SEO" (the project owner decides).
export function teamOf(team, cfg = {}) {
  const t = cfg.report?.teams?.[team] ?? team;
  return t || 'SEO';
}
// Query or project values for the head. Text only, length limit, no control characters.
export function cleanReportInfo(v = {}, cfg = {}) {
  const max = cfg.report?.maxNameLength ?? 80;
  const s = (x) => String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return { client: s(v.client), by: s(v.by) };
}
const audienceOf = (a) => (AUDIENCES.includes(a) ? a : 'musteri');
const limitOf = (cfg, audience) => cfg.report?.listLimit?.[audience] ?? (audience === 'ekip' ? 50 : 20);

// Group work units by team in the configured order. units: [{ team, title, n, unit, jobs, ... }].
function byTeam(units, cfg) {
  const order = cfg.report?.teamOrder || ['Backend', 'Frontend', 'İçerik', 'SEO'];
  const map = new Map(order.map((t) => [t, []]));
  for (const u of units) (map.get(u.team) || map.set(u.team, []).get(u.team)).push(u);
  return [...map].filter(([, list]) => list.length).map(([team, list]) => ({ team, jobs: list.reduce((a, u) => a + u.jobs, 0), units: list }));
}

// Score without the rules that are normal on staging (robots.txt Disallow: the "site" rule caps the score at 40).
// Only site rules can be left out: the page share does not change.
export function stagingScore(audit, cfg = {}) {
  const ids = new Set(cfg.report?.stagingRules || []);
  const hit = audit.rules.filter((r) => ids.has(r.id) && r.count && r.scope === 'site' && r.severity === 'critical');
  if (!hit.length) return { score: audit.score, adjusted: false };
  const other = audit.rules.filter((r) => r.severity === 'critical' && r.scope === 'site' && r.count && !ids.has(r.id)).length;
  let score = audit.totalUrls ? Math.round((audit.healthyUrls / audit.totalUrls) * 100) : 0;
  if (other) score = Math.min(score, 40);
  return { score, adjusted: true, left: hit.map((r) => r.title) };
}

// ---------- Site audit ----------
// meta: crawl meta. audit: runAudit result. info: { client, by }.
export function siteReport({ meta, audit, cfg = {}, audience = 'musteri', info = {}, now = new Date() }) {
  audience = audienceOf(audience);
  const min = sevRank(cfg.report?.minSeverity || 'warning');
  const hit = audit.rules.filter((r) => r.count);
  const active = hit.filter((r) => sevRank(r.severity) <= min);
  const crit = active.filter((r) => r.severity === 'critical');
  const warn = active.filter((r) => r.severity === 'warning');
  const left = hit.length - active.length;
  const unitOf = (r) => (r.scope === 'site' ? 'kayıt' : 'sayfa');
  const units = active.map((r) => ({
    team: teamOf(r.team, cfg), title: r.title, n: r.count, unit: unitOf(r), jobs: 1, sev: r.severity, key: `kural:${r.id}`, ruleId: r.id, fix: r.fix, note: r.description, place: '',
    cols: ['Adres', 'Ayrıntı'], rows: r.items.map((i) => [i.url || '', i.detail || '']),
  }));
  const notes = [];
  if (meta.cancelled) notes.push('Tarama elle durduruldu. Sonuçlar eksik.');
  if (meta.limitReached) notes.push(`URL sınırına ulaşıldı. ${nf(meta.notCrawled)} adres taranmadı.`);
  if (left) notes.push(`${nf(left)} bilgi notu rapora girmedi. Notlar Excel dosyasında.`);
  return {
    kind: 'site', audience, info: cleanReportInfo(info, cfg), date: now.toISOString(),
    title: meta.host, subtitle: `Site denetimi · tarama ${day(meta.startedAt)}`, stage: null,
    summary: `${meta.host} sitesinde ${nf(audit.totalUrls)} adres tarandı. Sağlık skoru ${audit.score}.`
      + (crit.length ? ` ${nf(crit.length)} kritik sorun var. Önce bunları düzeltin.` : ' Kritik sorun yok.'),
    metrics: [
      { label: 'Sağlık skoru', value: String(audit.score), tone: audit.score >= 80 ? 'ok' : audit.score >= 50 ? 'warn' : 'bad' },
      { label: 'Taranan adres', value: nf(audit.totalUrls) },
      { label: 'Kritik sorun', value: nf(crit.length), tone: crit.length ? 'bad' : 'ok' },
      { label: 'Uyarı', value: nf(warn.length), tone: warn.length ? 'warn' : 'ok' },
    ],
    critical: units.filter((u) => u.sev === 'critical'),
    teams: byTeam(units, cfg), steps: null, units, notes,
    limit: limitOf(cfg, audience), excel: 'Sorunlar',
  };
}

// ---------- Migration project ----------
// project: definition. m: projectMatch result ({ cmp, sections, status, map, todo, launch }). verify: projectVerify or null.
// score: { audit, staging, live } for the heir (live: the audit is from the live crawl). names: site key → display name.
export function projectReport({ project, m, verify = null, score = null, names = {}, cfg = {}, audience = 'musteri', info = {}, now = new Date() }) {
  audience = audienceOf(audience);
  const S = m.cmp.summary;
  const launched = !!project.launch;
  const siteName = (k) => (k === 'server' ? `${bare(m.cmp.old.host)} sunucusu` : names[k] || k || '');
  const units = [];

  if (!launched) {
    // Work list (as the Yapılacaklar screen): one unit per place and task kind. Held tasks (thin site) wait.
    const placeBy = new Map(m.todo.places.map((p) => [p.key, p]));
    const groups = new Map();
    for (const it of m.todo.items.filter((x) => !x.held)) {
      const k = `${it.placeKey}|${it.task}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(it);
    }
    for (const [k, list] of groups) {
      const p = placeBy.get(list[0].placeKey) || {};
      const place = p.kind === 'site' ? (names[p.site] || p.title) : p.title;
      units.push({ team: teamOf(p.team, cfg), title: TODO_TASKS[list[0].task] || list[0].label, n: list.length, unit: 'adres', jobs: list.length, sev: 'warning',
        key: `yapilacaklar:${k}`, place, note: '', fix: '', cols: ['Eski adres', 'Yeni adres', 'Not'],
        rows: list.map((it) => [it.oldUrl || it.path, it.liveUrl || it.checkUrl || '', it.note || '']) });
    }
    // Launch list: critical, switch at launch, check. "Karar bekleyen" is the work list's decision unit (no double count).
    for (const g of m.launch.groups.filter((x) => x.key !== 'decide')) {
      for (const it of g.items.filter((x) => !x.info)) {
        units.push({ team: teamOf(it.team, cfg), title: it.title, n: it.n, unit: it.unit, jobs: 1, sev: g.key === 'critical' ? 'critical' : 'warning',
          key: `canliya:${it.kind || g.key}:${it.site || ''}`, place: siteName(it.site), note: it.note || '', fix: '', group: g.title, cols: ['Adres', 'Değer'],
          rows: (it.list || []).map((r) => [r.page || '', r.value || '']) });
      }
    }
  } else if (verify) {
    for (const g of verify.groups.filter((x) => x.key !== 'ok')) {
      for (const it of g.items.filter((x) => !x.info && x.kind !== 'live-running')) {
        const redirect = it.listKind === 'redirect';
        units.push({ team: teamOf(it.team, cfg), title: it.title, n: it.n, unit: it.unit, jobs: 1, sev: g.key === 'critical' ? 'critical' : 'warning',
          key: `dogrulama:${it.kind}:${it.site || ''}`, place: siteName(it.site), note: it.note || '', fix: '', group: g.title,
          cols: redirect ? ['Eski adres', 'Beklenen', 'Canlıda'] : ['Adres', 'Değer'],
          rows: (it.list || []).map((r) => (redirect ? [r.old || '', r.expect || '', r.got || ''] : [r.page || '', r.value || ''])) });
      }
    }
  }
  units.sort((a, b) => sevRank(a.sev) - sevRank(b.sev));
  const crit = units.filter((u) => u.sev === 'critical');

  // Numbers of the summary.
  const keptN = (S.same || 0) + (S.changed || 0) + (S.unlinked || 0) + (S.moved || 0);
  const ms = m.map.summary || {};
  const open = (ms.pending || 0) + (ms.none || 0);
  const decided = Math.max(0, (ms.total || 0) - open - (ms.wait || 0));
  const jobs = units.reduce((a, u) => a + u.jobs, 0);
  const metrics = [{ label: 'Korunan sayfa', value: `%${S.kept}`, sub: `${nf(keptN)} / ${nf(S.oldPages)}`, tone: S.kept >= 95 ? 'ok' : S.kept >= 80 ? 'warn' : 'bad' }];
  const notes = [];
  if (score?.audit) {
    const sc = score.staging && !score.live ? stagingScore(score.audit, cfg) : { score: score.audit.score, adjusted: false };
    metrics.push({ label: score.live ? 'Sağlık skoru (canlı)' : 'Sağlık skoru (yeni site)', value: String(sc.score), tone: sc.score >= 80 ? 'ok' : sc.score >= 50 ? 'warn' : 'bad' });
    if (sc.adjusted) notes.push(`Sağlık skoru staging ayarını saymaz (${sc.left.join(', ')}). Bu ayar çıkışta değişir.`);
  }
  metrics.push({ label: 'Kritik iş', value: nf(crit.length), tone: crit.length ? 'bad' : 'ok' });
  metrics.push({ label: 'Açık iş', value: nf(jobs), tone: jobs ? 'warn' : 'ok' });

  let summary;
  if (!launched) {
    summary = `Eski sitenin ${nf(S.oldPages)} sayfasından ${nf(keptN)} tanesi yeni sitede yerinde (%${S.kept}).`
      + (crit.length ? ` ${nf(crit.length)} kritik iş çıkıştan önce düzelmeli.` : ' Kritik iş yok.')
      + (open ? ` ${nf(open)} adres için 301 kararı bekliyor.` : '');
  } else if (verify) {
    const r = verify.redirects;
    summary = `Site ${day(project.launch.at)} tarihinde canlıya çıktı. ${nf(r.total)} eski adres canlıda kontrol edildi: ${nf(r.ok)} tamam, ${nf(r.critical)} kritik, ${nf(r.fix)} düzeltme, ${nf(r.unknown)} kontrol edilemedi.`;
  } else {
    summary = `Site ${day(project.launch.at)} tarihinde canlıya çıktı. Canlı doğrulama sonucu yok.`;
  }
  if (launched) notes.push('Çıkıştan önceki iş listesi Excel dosyasında ("Yapılacaklar" sayfası).');
  if (verify?.notSwitched) notes.push('301 beklenen adreslerin çoğu yönlenmeden açılıyor. Eski alan adı hâlâ eski siteyi sunuyor olabilir. DNS geçişini kontrol edin.');
  const held = m.todo.held || 0;
  if (!launched && held) notes.push(`${nf(held)} iş bekliyor: site hazır görünmüyor. Bu işler rapora girmedi.`);

  // Steps of the migration (as the step bar).
  const st = m.status || {};
  const sites = project.sites || [];
  const crawled = sites.filter((s) => ['done', 'stale'].includes(st[s.key]?.state)).length;
  const alerts = (m.sections || []).filter((x) => x.alert).length;
  const lc = m.launch.counts || {};
  const steps = [
    { label: 'Tarama', text: `${crawled} / ${sites.length} site`, tone: crawled === sites.length ? 'ok' : 'warn' },
    { label: 'Eşleştirme', text: alerts ? `%${S.kept} korundu · ${alerts} bölüm uyarısı` : `%${S.kept} korundu`, tone: alerts ? 'warn' : 'ok' },
    { label: '301 haritası', text: ms.total ? `${nf(decided)} / ${nf(ms.total)} karar` : '301 gerekmiyor', tone: open ? 'warn' : 'ok' },
    launched ? { label: 'Yapılacaklar', text: 'Çıkıştan önceki liste', tone: 'off' }
      : { label: 'Yapılacaklar', text: m.todo.total ? `${nf(m.todo.total)} iş` : 'İş yok', tone: m.todo.total ? 'warn' : 'ok' },
    launched ? { label: 'Canlıya çıkış', text: `Çıkış ${day(project.launch.at)}`, tone: 'ok' }
      : { label: 'Canlıya çıkış', text: lc.critical ? `${nf(lc.critical)} kritik` : 'Kritik iş yok', tone: lc.critical ? 'bad' : 'ok' },
    !launched ? { label: 'Canlı doğrulama', text: 'Çıkıştan sonra', tone: 'off' }
      : verify ? { label: 'Canlı doğrulama', text: verify.counts.critical ? `${nf(verify.counts.critical)} kritik` : verify.total ? `${nf(verify.total)} iş` : 'Tamam',
        tone: verify.counts.critical ? 'bad' : verify.total ? 'warn' : 'ok' }
        : { label: 'Canlı doğrulama', text: 'Sonuç yok', tone: 'warn' },
  ];
  // The heir takes the old domain at launch. Before launch its crawl host is usually staging.
  const oldH = bare(m.cmp.old.host), heirH = bare(m.cmp.new?.host || '');
  const route = launched ? `${oldH} · yeni site canlıda` : heirH && heirH !== oldH ? `${oldH} → ${heirH}${score?.staging ? ' (staging)' : ''}` : oldH;
  return {
    kind: 'project', audience, info: cleanReportInfo(info, cfg), date: now.toISOString(),
    title: project.name, subtitle: `Taşıma raporu · ${route}`,
    stage: launched ? `Canlıya çıktı · ${day(project.launch.at)}` : 'Canlıya çıkış öncesi',
    summary, metrics, critical: crit, teams: byTeam(units, cfg), steps, units, notes,
    limit: limitOf(cfg, audience), excel: launched ? 'Canlı doğrulama' : 'Yapılacaklar',
  };
}

// ---------- HTML ----------
// Addresses are links only with http or https. Other text stays text.
const cell = (v) => (/^https?:\/\//i.test(String(v)) ? `<a href="${esc(v)}" rel="noopener noreferrer">${esc(v)}</a>` : esc(v));
const STYLE = `
:root{--ink:#1d2125;--muted:#5b6470;--line:#d9dde2;--soft:#f3f5f7;--red:#b42318;--red-bg:#fdecea;--amber:#8a5a00;--amber-bg:#fdf3dc;--green:#1e6b3c;--green-bg:#e6f4ea}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 24px 48px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);padding-bottom:16px}
.client{margin:0;color:var(--muted);font-size:13px}
h1{margin:4px 0 2px;font-size:26px;line-height:1.2;overflow-wrap:anywhere}
.sub{margin:0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.stage{flex:none;font-size:13px;padding:5px 10px;border-radius:6px;background:var(--amber-bg);color:var(--amber);white-space:nowrap}
.stage.done{background:var(--green-bg);color:var(--green)}
.lead{font-size:17px;margin:18px 0}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.metric{background:var(--soft);border-radius:8px;padding:12px 14px}
.metric p{margin:0;font-size:13px;color:var(--muted)}
.metric b{display:block;font-size:28px;line-height:1.2}
.metric small{color:var(--muted);font-size:12px}
.metric.bad{background:var(--red-bg)}.metric.bad b,.metric.bad p{color:var(--red)}
.metric.warn b{color:var(--amber)}.metric.ok b{color:var(--green)}
h2{font-size:18px;margin:30px 0 10px}
.list{border:1px solid var(--line);border-radius:8px;margin:0;padding:0;list-style:none}
.list li{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}
.list .t{overflow-wrap:anywhere}
.tag{flex:none;color:var(--muted);font-size:13px;text-align:right}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.empty{color:var(--muted);margin:0}
.teams{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.team{border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.team h3{margin:0 0 4px;font-size:15px}
.team ul{margin:0;padding-left:18px;color:var(--muted);font-size:13px}
.steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}
.steps li{font-size:13px;padding:6px 10px;border-radius:6px;background:var(--soft);color:var(--muted)}
.steps li b{color:var(--ink);font-weight:600}
.steps .ok{background:var(--green-bg);color:var(--green)}.steps .ok b{color:var(--green)}
.steps .warn{background:var(--amber-bg);color:var(--amber)}.steps .warn b{color:var(--amber)}
.steps .bad{background:var(--red-bg);color:var(--red)}.steps .bad b{color:var(--red)}
details{border:1px solid var(--line);border-radius:8px;margin:0 0 8px}
summary{cursor:pointer;padding:10px 12px;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
summary .t{font-weight:600;overflow-wrap:anywhere}
summary .tag{margin-left:auto}
.crit summary .t{color:var(--red)}
.box{padding:0 12px 12px}
.box p{margin:0 0 8px;font-size:14px}
.wrap{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:5px 8px 5px 0;border-top:1px solid var(--line);overflow-wrap:anywhere;word-break:break-word}
th{color:var(--muted);font-weight:500;border-top:0}
a{color:#1f5f99}
.more{color:var(--muted);font-size:13px;margin:8px 0 0}
.notes{color:var(--muted);font-size:14px;padding-left:18px}
footer{margin-top:36px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:700px){main{padding:20px 16px 36px}header{flex-direction:column}.metrics,.teams{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:480px){.teams{grid-template-columns:1fr}h1{font-size:22px}.metric b{font-size:24px}}
@media print{main{max-width:none;padding:0}details{break-inside:avoid-page}details::details-content{content-visibility:visible;display:block}a{color:inherit;text-decoration:none}}
`;

export function renderReport(model, { version = '' } = {}) {
  const ekip = model.audience === 'ekip';
  const idOf = (u) => (ekip && u.ruleId ? ` <code>${esc(u.ruleId)}</code>` : '');
  const count = (u) => (u.n ? ` · ${esc(nf(u.n))}${u.unit ? ` ${esc(u.unit)}` : ''}` : '');
  const place = (u) => [u.team, u.place].filter(Boolean).map(esc).join(' · ');
  const info = model.info || {};
  const head = `<header><div>
<p class="client">${esc(info.client || (model.kind === 'project' ? 'Taşıma raporu' : 'Site denetimi'))}</p>
<h1>${esc(model.title)}</h1>
<p class="sub">${esc(model.subtitle)}</p>
<p class="sub">Rapor tarihi ${esc(day(model.date))}${info.by ? ` · Hazırlayan: ${esc(info.by)}` : ''}</p>
</div>${model.stage ? `<span class="stage${/çıktı/.test(model.stage) ? ' done' : ''}">${esc(model.stage)}</span>` : ''}</header>`;
  const metrics = `<section class="metrics" aria-label="Özet sayılar">${model.metrics.map((x) =>
    `<div class="metric${x.tone ? ` ${x.tone}` : ''}"><p>${esc(x.label)}</p><b>${esc(x.value)}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</div>`).join('')}</section>`;
  let n = 0;
  const h2 = (t) => `<h2>${++n}. ${esc(t)}</h2>`;
  const critical = `<section>${h2('Kritik işler')}${model.critical.length
    ? `<ul class="list">${model.critical.map((u) => `<li><span class="t">${esc(u.title)}${count(u)}${idOf(u)}</span><span class="tag">${place(u)}</span></li>`).join('')}</ul>`
    : '<p class="empty">Kritik iş yok.</p>'}</section>`;
  const teams = `<section>${h2('Ekip başına işler')}${model.teams.length
    ? `<div class="teams">${model.teams.map((t) => `<div class="team"><h3>${esc(t.team)} · ${esc(nf(t.jobs))} iş</h3><ul>${t.units.map((u) =>
      `<li>${esc(u.title)}${u.n ? ` · ${esc(nf(u.n))}${u.unit ? ` ${esc(u.unit)}` : ''}` : ''}${u.place ? ` (${esc(u.place)})` : ''}</li>`).join('')}</ul></div>`).join('')}</div>`
    : '<p class="empty">Açık iş yok.</p>'}</section>`;
  const steps = model.steps ? `<section>${h2('Taşıma durumu')}<ol class="steps">${model.steps.map((s) =>
    `<li class="${esc(s.tone)}"><b>${esc(s.label)}</b> · ${esc(s.text)}</li>`).join('')}</ol></section>` : '';
  const lim = model.limit;
  const lists = model.units.filter((u) => u.rows.length || u.note || u.fix);
  const listSec = `<section>${h2('Adres listeleri')}${lists.length ? lists.map((u) => {
    const rows = u.rows.slice(0, lim);
    const keep = u.cols.map((c, i) => i === 0 || rows.some((r) => String(r[i] ?? '').trim())); // an empty column only takes room
    const pick = (list) => list.filter((x, i) => keep[i]);
    const table = rows.length ? `<div class="wrap"><table><thead><tr>${pick(u.cols).map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
      `<tr>${pick(r).map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    const more = u.rows.length > lim ? `<p class="more">İlk ${esc(nf(lim))} satır görünüyor (${esc(nf(u.rows.length))} satır var). Bütün liste Excel dosyasında.</p>` : '';
    return `<details${u.sev === 'critical' ? ' class="crit"' : ''}><summary><span class="t">${esc(u.title)}${count(u)}</span>${idOf(u)}<span class="tag">${place(u)}</span></summary><div class="box">${
      u.note ? `<p>${esc(u.note)}</p>` : ''}${u.fix ? `<p><b>Çözüm:</b> ${esc(u.fix)}</p>` : ''}${table}${more}</div></details>`;
  }).join('') : '<p class="empty">Liste yok.</p>'}<p class="more">Listeler kapalı gelir. Başlığa tıklayın. Yazdırmadan önce listeleri açın.</p></section>`;
  const notes = model.notes.length ? `<section>${h2('Notlar')}<ul class="notes">${model.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : '';
  const foot = `<footer>SEO Audit${version ? ` ${esc(version)}` : ''} ile hazırlandı. Bütün listeler Excel dosyasında ("${esc(model.excel)}" sayfası).${ekip && model.kind === 'site' ? ' Kural kimliği Excel\'de "Kural ID" sütunundadır.' : ''}</footer>`;
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(REPORT_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(model.title)} · ${model.kind === 'project' ? 'Taşıma raporu' : 'Site denetimi'}</title>
<style>${STYLE}</style></head>
<body><main>
${head}
<p class="lead">${esc(model.summary)}</p>
${metrics}
${critical}
${teams}
${steps}
${listSec}
${notes}
${foot}
</main></body></html>
`;
}

// File name: ASCII letters, digits and hyphens only (the header cannot carry other text safely).
export function reportFileName(name, date = new Date()) {
  const tr = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c' };
  const slug = String(name || '').toLocaleLowerCase('tr').replace(/[ğüşıöç]/g, (c) => tr[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'site';
  return `rapor-${slug}-${date.toISOString().slice(0, 10)}.html`;
}
