// Validation (v0.10.2): compares a crawl of this tool with the export of a reference crawler
// (Screaming Frog: Internal tab → All → Export, CSV). The result shows where the two tools disagree.
// Every difference is one of three things: a bug of the tool, a wrong threshold, or an expected difference.
import { normalizeUrl } from './normalize.js';
import { isIndexable, titlePx } from './rules/helpers.js';

// Small CSV reader: quoted fields, "" inside quotes, line breaks inside quotes, BOM. Finds , ; or tab by the header line.
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n/) < 0 ? src.length : src.search(/\r?\n/));
  const count = (ch) => firstLine.split(ch).length;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Column names of the reference export. The first name that exists is used. Names are compared in lower case.
const COLUMNS = {
  url: ['url encoded address', 'address'],
  contentType: ['content type', 'content'],
  status: ['status code'],
  indexability: ['indexability'],
  indexabilityStatus: ['indexability status'],
  title: ['title 1'],
  titlePx: ['title 1 pixel width'],
  description: ['meta description 1'],
  h1: ['h1-1'],
  metaRobots: ['meta robots 1'],
  canonical: ['canonical link element 1'],
  wordCount: ['word count'],
  depth: ['crawl depth'],
  inlinks: ['unique inlinks'],
  redirectUrl: ['redirect url'],
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (s) => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return String(s ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };

// Reads the reference export. Returns { pages: Map(url → row), columns: { found, missing }, rows }.
export function readReference(csvText) {
  const rows = parseCsv(csvText);
  // Some exports have a title line before the header line: the header is the first line with an address column.
  const hi = rows.findIndex((r) => r.some((c) => COLUMNS.url.includes(clean(c).toLowerCase())));
  if (hi < 0) throw new Error('Dosyada "Address" sütunu yok. Screaming Frog → Internal → All → Export ile CSV alın.');
  const head = rows[hi].map((c) => clean(c).toLowerCase());
  const idx = {}; const found = []; const missing = [];
  for (const [key, names] of Object.entries(COLUMNS)) {
    const i = names.map((n) => head.indexOf(n)).find((x) => x >= 0);
    if (i === undefined) missing.push(`${key} (${names[0]})`); else { idx[key] = i; found.push(key); }
  }
  const pages = new Map();
  for (const r of rows.slice(hi + 1)) {
    const url = normalizeUrl(clean(r[idx.url]));
    if (!url) continue;
    const get = (k) => (idx[k] === undefined ? undefined : clean(r[idx[k]]));
    pages.set(url, {
      url, contentType: get('contentType') ?? '', status: num(get('status')),
      indexable: get('indexability') === undefined ? undefined : /^indexable$/i.test(get('indexability')),
      indexabilityStatus: get('indexabilityStatus') ?? '',
      title: get('title'), titlePx: num(get('titlePx')), description: get('description'), h1: get('h1'),
      metaRobots: get('metaRobots')?.toLowerCase(), canonical: get('canonical') === undefined ? undefined : (get('canonical') ? normalizeUrl(get('canonical'), url) || get('canonical') : ''),
      wordCount: num(get('wordCount')), depth: num(get('depth')), inlinks: num(get('inlinks')),
      redirectUrl: get('redirectUrl') === undefined ? undefined : (get('redirectUrl') ? normalizeUrl(get('redirectUrl'), url) || get('redirectUrl') : ''),
    });
  }
  return { pages, columns: { found, missing }, rows: rows.length - hi - 1 };
}

const FIELD_NAMES = {
  status: 'Durum kodu', redirect: 'Yönlendirme hedefi', title: 'Title', description: 'Meta description', h1: 'İlk H1',
  canonical: 'Canonical', metaRobots: 'Meta robots', indexable: 'İndekslenebilir', wordCount: 'Kelime sayısı',
  inlinks: 'İç link sayısı', depth: 'Derinlik', titlePx: 'Title genişliği (px)',
};
export const fieldName = (k) => FIELD_NAMES[k] || k;

// Two numbers agree when the difference is small: at most `abs`, or at most `ratio` of the larger number.
const near = (a, b, ratio, abs) => Math.abs(a - b) <= Math.max(abs, ratio * Math.max(Math.abs(a), Math.abs(b)));
const robotsSet = (s) => String(s || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => x && x !== 'index' && x !== 'follow' && x !== 'all').sort().join(', ');

// Compares the crawl with the reference. cfg: config/rules.json → validate.
export function compareWithReference(result, ref, cfg = {}) {
  const c = { wordRatio: 0.25, wordAbs: 30, inlinkRatio: 0.25, inlinkAbs: 3, titlePxAbs: 40, sampleLimit: 25, ...cfg };
  const tool = new Map(result.pages.map((p) => [p.url, p]));
  const isHtmlRef = (r) => /html/i.test(r.contentType) || r.contentType === '';
  const diffs = [];
  const add = (url, field, a, b, note = '') => diffs.push({ url, field, tool: a ?? '', ref: b ?? '', note });
  let both = 0;
  const compared = {};
  const count = (f) => { compared[f] = (compared[f] || 0) + 1; };

  for (const [url, r] of ref.pages) {
    const p = tool.get(url);
    if (!p || p.blockedByRobots) continue;
    both++;
    if (r.status != null) { count('status'); if ((p.status ?? 0) !== r.status) add(url, 'status', p.status ?? 0, r.status, p.error || ''); }
    const redirected = !!p.redirectChain?.length;
    if (r.redirectUrl !== undefined && (redirected || r.redirectUrl)) {
      count('redirect');
      const to = redirected ? p.redirectChain[0].to || '' : '';
      if (to !== r.redirectUrl) add(url, 'redirect', to, r.redirectUrl);
    }
    // Content fields: only for pages both tools read as an HTML page with 200.
    if (p.status !== 200 || redirected || r.status !== 200 || !/html/i.test(p.contentType || '')) continue;
    const text = (f, a, b) => { if (b === undefined) return; count(f); if (clean(a) !== clean(b)) add(url, f, clean(a), clean(b)); };
    text('title', p.title, r.title);
    text('description', p.metaDescription, r.description);
    text('h1', p.h1?.[0], r.h1);
    text('canonical', p.canonical, r.canonical);
    if (r.metaRobots !== undefined) { count('metaRobots'); if (robotsSet(p.metaRobots) !== robotsSet(r.metaRobots)) add(url, 'metaRobots', p.metaRobots, r.metaRobots); }
    if (r.indexable !== undefined) { count('indexable'); const a = isIndexable(p); if (a !== r.indexable) add(url, 'indexable', a ? 'evet' : 'hayır', r.indexable ? 'evet' : 'hayır', r.indexabilityStatus); }
    if (r.wordCount != null && p.wordCount != null) {
      count('wordCount');
      // The reference may count the whole body or only the content area. The closer number of the tool is used.
      const best = [p.wordCount, p.contentWordCount].filter((x) => x != null).sort((x, y) => Math.abs(x - r.wordCount) - Math.abs(y - r.wordCount))[0];
      if (!near(best, r.wordCount, c.wordRatio, c.wordAbs)) add(url, 'wordCount', `${p.wordCount} (ana içerik ${p.contentWordCount ?? '-'})`, r.wordCount);
    }
    if (r.inlinks != null && p.inlinks != null) { count('inlinks'); if (!near(p.inlinks, r.inlinks, c.inlinkRatio, c.inlinkAbs)) add(url, 'inlinks', p.inlinks, r.inlinks); }
    if (r.depth != null && p.depth != null) { count('depth'); if (p.depth !== r.depth) add(url, 'depth', p.depth, r.depth); }
    if (r.titlePx != null && p.title) { count('titlePx'); const px = titlePx(p.title); if (Math.abs(px - r.titlePx) > c.titlePxAbs) add(url, 'titlePx', px, r.titlePx, p.title); }
  }

  const onlyRef = [...ref.pages.values()].filter((r) => !tool.has(r.url) && isHtmlRef(r)).map((r) => ({ url: r.url, status: r.status, indexability: r.indexabilityStatus || (r.indexable ? 'Indexable' : '') }));
  const refOther = [...ref.pages.values()].filter((r) => !tool.has(r.url) && !isHtmlRef(r)).length;
  const onlyTool = result.pages.filter((p) => !ref.pages.has(p.url)).map((p) => ({ url: p.url, status: p.blockedByRobots ? 'robots engeli' : p.status ?? 0, foundBy: p.discoveredBy || '' }));

  const fields = {};
  for (const f of Object.keys(FIELD_NAMES)) {
    const list = diffs.filter((d) => d.field === f);
    if (!compared[f] && !list.length) continue;
    fields[f] = { name: fieldName(f), compared: compared[f] || 0, different: list.length, samples: list.slice(0, c.sampleLimit) };
  }
  return {
    host: result.meta.host, toolVersion: result.meta.version, crawledAt: result.meta.startedAt,
    toolPages: result.pages.length, refRows: ref.pages.size, both,
    columns: ref.columns,
    onlyTool: { count: onlyTool.length, samples: onlyTool.slice(0, c.sampleLimit) },
    onlyRef: { count: onlyRef.length, samples: onlyRef.slice(0, c.sampleLimit), otherTypes: refOther },
    fields, diffs,
  };
}

const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// All differences as CSV (UTF-8 BOM for Excel). Formula characters at the start of a cell get a quote, like the 301 list.
export function diffCsv(report) {
  const rows = [['url', 'alan', 'arac', 'referans', 'not']];
  for (const d of report.diffs) rows.push([d.url, fieldName(d.field), d.tool, d.ref, d.note]);
  for (const p of report.onlyTool.all || report.onlyTool.samples) rows.push([p.url, 'Sadece araç buldu', p.status, '', p.foundBy]);
  for (const p of report.onlyRef.all || report.onlyRef.samples) rows.push([p.url, 'Sadece referans buldu', '', p.status, p.indexability]);
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Short text for the terminal.
export function summaryText(report) {
  const out = [];
  out.push(`Site: ${report.host} · araç ${report.toolPages} URL · referans ${report.refRows} satır · ortak ${report.both} URL`);
  if (report.columns.missing.length) out.push(`UYARI: referans dosyasında şu sütunlar yok, bu alanlar karşılaştırılmadı: ${report.columns.missing.join(', ')}`);
  out.push(`Sadece araç buldu: ${report.onlyTool.count} URL`);
  out.push(`Sadece referans buldu: ${report.onlyRef.count} HTML URL (HTML olmayan ${report.onlyRef.otherTypes} satır sayılmadı)`);
  out.push('');
  out.push('Alan                      Karşılaştırılan   Farklı');
  for (const f of Object.values(report.fields)) out.push(`${f.name.padEnd(26)}${String(f.compared).padStart(15)}${String(f.different).padStart(9)}`);
  return out.join('\n');
}
