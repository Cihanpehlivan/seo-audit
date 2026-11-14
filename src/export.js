// Writes crawl results to an Excel file for the team.
import ExcelJS from 'exceljs';
import { FIX } from './compare.js';
import { RESULT as LIST_RESULT } from './urllist.js';

const HEAD = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3C3489' } } };

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).eachCell((c) => Object.assign(c, HEAD));
  ws.addRows(rows);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

const SEV = { critical: 'Kritik', warning: 'Uyarı', notice: 'Bilgi' };
const SEV_FILL = { critical: 'FFF8D7DA', warning: 'FFFFF1D6', notice: 'FFE8EEF4' };

export async function exportExcel(result, file, audit = null) {
  const wb = new ExcelJS.Workbook();
  const { meta, pages } = result;
  const catName = audit ? Object.fromEntries(audit.categories) : {};
  const html = pages.filter((p) => !p.redirectChain?.length && /html/i.test(p.contentType || ''));
  const count = (f) => pages.filter(f).length;

  sheet(wb, 'Özet', [{ header: 'Metrik', key: 'k', width: 40 }, { header: 'Değer', key: 'v', width: 60 }], [
    { k: 'Başlangıç URL', v: meta.startUrl },
    { k: 'Tarama başlangıç', v: meta.startedAt },
    { k: 'Tarama bitiş', v: meta.finishedAt },
    { k: 'Taranan URL', v: pages.length },
    { k: 'HTML sayfa (200)', v: count((p) => p.status === 200 && /html/i.test(p.contentType || '')) },
    { k: 'Redirect (3xx)', v: count((p) => p.status >= 300 && p.status < 400) },
    { k: 'İstemci hatası (4xx)', v: count((p) => p.status >= 400 && p.status < 500) },
    { k: 'Sunucu hatası (5xx)', v: count((p) => p.status >= 500) },
    { k: 'Bağlantı hatası / timeout', v: count((p) => p.status === 0) },
    { k: 'robots.txt ile engelli', v: count((p) => p.blockedByRobots) },
    { k: 'Sitemap URL sayısı', v: meta.sitemap.urlCount },
    { k: 'Yetim sayfa (sadece sitemap)', v: count((p) => p.orphan) },
    { k: 'robots.txt durumu', v: meta.robots.status },
    { k: 'URL limitine ulaşıldı', v: meta.limitReached ? 'EVET' : 'Hayır' },
    ...(meta.render ? [{ k: 'JavaScript render', v: meta.render.enabled
      ? `${meta.render.pages} sayfa render edildi, ${meta.render.failed} hata${meta.render.limitReached ? ', render sınırı doldu (sonrası ham)' : ''}${meta.render.allowHosts?.length ? ` · izinli dış alan adı: ${meta.render.allowHosts.join(', ')}` : ''}`
      : `Açılmadı: ${meta.render.error}. Sayfalar ham okundu.` }] : []),
    ...(audit ? [
      { k: 'Sağlık skoru', v: `${audit.score} / 100 (kritik sorunu olmayan URL oranı)` },
      { k: 'Kritik sorun türü', v: audit.counts.critical },
      { k: 'Uyarı türü', v: audit.counts.warning },
      { k: 'Bilgi türü', v: audit.counts.notice },
    ] : []),
    ...siteRows(result.checks),
  ]);

  if (audit) {
    const active = audit.rules.filter((r) => r.count);
    const ws = sheet(wb, 'Sorunlar', [
      { header: 'Önem', key: 'sev', width: 9 }, { header: 'Kategori', key: 'cat', width: 22 },
      { header: 'Sorun', key: 'title', width: 42 }, { header: 'Etkilenen', key: 'count', width: 10 },
      { header: 'Ekip', key: 'team', width: 10 }, { header: 'Açıklama', key: 'description', width: 60 },
      { header: 'Çözüm', key: 'fix', width: 60 }, { header: 'Kural ID', key: 'id', width: 24 },
    ], active.map((r) => ({ ...r, sev: SEV[r.severity], cat: catName[r.category] })));
    ws.eachRow((row, i) => { if (i > 1) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEV_FILL[active[i - 2].severity] } }; });
    ws.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
    ws.getColumn('fix').alignment = { wrapText: true, vertical: 'top' };

    const detail = sheet(wb, 'Sorun detayları', [
      { header: 'Önem', key: 'sev', width: 9 }, { header: 'Sorun', key: 'title', width: 40 }, { header: 'URL', key: 'url', width: 60 },
      { header: 'Detay', key: 'detail', width: 70 }, { header: 'Ekip', key: 'team', width: 10 }, { header: 'Kural ID', key: 'id', width: 24 },
    ], active.flatMap((r) => r.items.map((i) => ({ sev: SEV[r.severity], title: r.title, url: i.url, detail: i.detail, team: r.team, id: r.id }))));
    detail.getColumn('detail').alignment = { wrapText: true, vertical: 'top' };
  }

  sheet(wb, 'Sayfalar', [
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Status', key: 'status', width: 8 },
    { header: 'Derinlik', key: 'depth', width: 9 },
    { header: 'Inlink', key: 'inlinks', width: 8 },
    { header: 'Sitemap', key: 'inSitemap', width: 9 },
    { header: 'Title', key: 'title', width: 50 },
    { header: 'Title uzunluk', key: 'titleLen', width: 12 },
    { header: 'Meta description', key: 'metaDescription', width: 60 },
    { header: 'MD uzunluk', key: 'mdLen', width: 11 },
    { header: 'H1', key: 'h1', width: 40 },
    { header: 'H1 sayısı', key: 'h1Count', width: 9 },
    { header: 'Canonical', key: 'canonical', width: 50 },
    { header: 'Meta robots', key: 'metaRobots', width: 18 },
    { header: 'X-Robots-Tag', key: 'xRobotsTag', width: 15 },
    { header: 'html lang', key: 'htmlLang', width: 9 },
    { header: 'Hreflang', key: 'hreflang', width: 40 },
    { header: 'Kelime', key: 'wordCount', width: 8 },
    { header: 'Görsel', key: 'imageCount', width: 8 },
    { header: 'Alt eksik', key: 'imgNoAlt', width: 9 },
    { header: 'Süre (ms)', key: 'responseMs', width: 9 },
    { header: 'Boyut (KB)', key: 'kb', width: 10 },
    { header: 'Sıkıştırma', key: 'contentEncoding', width: 11 },
    { header: 'Bulunduğu sayfa', key: 'foundOn', width: 50 },
    { header: 'Kaynak', key: 'discoveredBy', width: 10 },
  ], html.map((p) => ({
    ...p,
    titleLen: p.title?.length ?? 0,
    mdLen: p.metaDescription?.length ?? 0,
    h1: (p.h1 || [])[0] || '',
    h1Count: (p.h1 || []).length,
    inSitemap: p.inSitemap ? 'Evet' : 'Hayır',
    hreflang: (p.hreflang || []).map((h) => `${h.lang}: ${h.url}`).join('\n'),
    kb: Math.round((p.sizeBytes || 0) / 102.4) / 10,
  })));

  // v0.13.0: raw HTML ↔ render, only in a render crawl. One row per page that was opened in the browser.
  if (meta.render) {
    const rp = pages.filter((p) => p.render && !p.render.skipped);
    const diff = (p) => {
      if (!p.raw) return '';
      const d = [];
      if (p.raw.title !== (p.title || '')) d.push('title');
      if ((p.raw.h1 || []).join('|') !== (p.h1 || []).join('|')) d.push('H1');
      if (p.raw.metaDescription !== (p.metaDescription || '')) d.push('description');
      if (p.raw.canonical !== (p.canonical || '')) d.push('canonical');
      if ((p.raw.metaRobots || '') !== (p.metaRobotsJs || '')) d.push('robots');
      const rw = p.raw.contentWordCount || 0, w = p.contentWordCount || 0;
      if (Math.abs(w - rw) >= 10 && Math.abs(w - rw) >= Math.max(rw, w) * 0.1) d.push('içerik');
      if (p.links?.some((l) => l.js && l.internal)) d.push('link');
      return d.join(', ');
    };
    const jsLinks = (p) => new Set((p.links || []).filter((l) => l.js && l.internal).map((l) => l.url)).size;
    sheet(wb, 'JavaScript farkı', [
      { header: 'URL', key: 'url', width: 60 }, { header: 'Render', key: 'ok', width: 12 }, { header: 'Değişen alanlar', key: 'diff', width: 28 },
      { header: 'Ham title', key: 'rt', width: 40 }, { header: 'Render title', key: 't', width: 40 },
      { header: 'Ham H1', key: 'rh', width: 30 }, { header: 'Render H1', key: 'h', width: 30 },
      { header: 'Ham kelime', key: 'rw', width: 11 }, { header: 'Render kelime', key: 'w', width: 13 },
      { header: 'Sadece JS iç link', key: 'jl', width: 15 }, { header: 'Ham canonical', key: 'rc', width: 40 }, { header: 'Render canonical', key: 'c', width: 40 },
      { header: 'Süre (ms)', key: 'ms', width: 10 }, { header: 'Engellenen dış istek', key: 'bl', width: 18 }, { header: 'Engellenen alan adları', key: 'bh', width: 40 },
      { header: 'robots.txt ile engelli kaynak', key: 'rb', width: 40 }, { header: 'Hata', key: 'err', width: 24 },
    ], rp.map((p) => ({
      url: p.url, ok: p.rendered ? 'Tamam' : 'Hata (ham)', diff: diff(p),
      rt: p.raw?.title ?? '', t: p.rendered ? p.title : '', rh: (p.raw?.h1 || [])[0] || '', h: p.rendered ? (p.h1 || [])[0] || '' : '',
      rw: p.raw?.contentWordCount ?? '', w: p.rendered ? p.contentWordCount : '', jl: jsLinks(p),
      rc: p.raw?.canonical ?? '', c: p.rendered ? p.canonical : '', ms: p.render.ms, bl: p.render.blocked || 0,
      bh: (p.render.blockedHosts || []).map((h) => `${h.host} (${h.n})`).join(', '), rb: (p.render.robotsBlocked || []).map((x) => x.url).join('\n'),
      err: p.render.error === 'timeout' ? 'Zaman aşımı' : p.render.error || '',
    })));
  }

  sheet(wb, 'Redirectler', [
    { header: 'Kaynak URL', key: 'url', width: 60 },
    { header: 'İlk status', key: 'status', width: 10 },
    { header: 'Hop sayısı', key: 'hops', width: 10 },
    { header: 'Zincir', key: 'chain', width: 80 },
    { header: 'Hedef URL', key: 'finalUrl', width: 60 },
    { header: 'Hedef status', key: 'finalStatus', width: 12 },
    { header: 'Hata', key: 'error', width: 18 },
    { header: 'Inlink', key: 'inlinks', width: 8 },
  ], pages.filter((p) => p.redirectChain?.length).map((p) => ({
    ...p,
    hops: p.redirectChain.length,
    chain: p.redirectChain.map((c) => `${c.status} ${c.url}`).join(' → ') + ` → ${p.finalStatus}`,
  })));

  sheet(wb, 'Hatalar', [
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Status', key: 'status', width: 8 },
    { header: 'Hata', key: 'error', width: 25 },
    { header: 'Bulunduğu sayfa', key: 'foundOn', width: 60 },
    { header: 'Inlink', key: 'inlinks', width: 8 },
  ], pages.filter((p) => p.status === 0 || (p.status >= 400 && !p.redirectChain?.length)));

  sheet(wb, 'Engelli (robots)', [{ header: 'URL', key: 'url', width: 80 }, { header: 'Bulunduğu sayfa', key: 'foundOn', width: 60 }],
    pages.filter((p) => p.blockedByRobots));

  sheet(wb, 'Sitemap dosyaları', [
    { header: 'Sitemap', key: 'url', width: 70 }, { header: 'Status', key: 'status', width: 10 },
    { header: 'URL sayısı', key: 'urlCount', width: 12 }, { header: 'Index', key: 'index', width: 8 },
  ], meta.sitemap.files.map((f) => ({ ...f, index: f.index ? 'Evet' : '' })));

  const ck = result.checks;
  if (ck?.site?.variants?.length) {
    sheet(wb, 'Site sürümleri', [
      { header: 'Sürüm', key: 'url', width: 40 }, { header: 'Zincir', key: 'chain', width: 30 }, { header: 'Son URL', key: 'finalUrl', width: 50 },
      { header: 'Son status', key: 'finalStatus', width: 11 }, { header: 'Hata', key: 'error', width: 30 },
    ], ck.site.variants.map((v) => ({ ...v, chain: v.chain.join(' → ') || '(yönlenmiyor)' })));
  }
  if (ck?.resources?.length) {
    sheet(wb, 'Dış kaynaklar', [
      { header: 'URL', key: 'url', width: 70 }, { header: 'Tür', key: 'kind', width: 12 }, { header: 'Status', key: 'status', width: 8 },
      { header: 'Boyut (KB)', key: 'kb', width: 11 }, { header: 'Content-Type', key: 'contentType', width: 22 },
      { header: 'Son URL', key: 'finalUrl', width: 60 }, { header: 'Hata', key: 'error', width: 20 }, { header: 'Süre (ms)', key: 'ms', width: 9 },
    ], ck.resources.map((r) => ({ ...r, kind: r.kinds.map((k) => (k === 'image' ? 'görsel' : 'link')).join(', '), kb: r.size != null ? Math.round(r.size / 102.4) / 10 : '' })));
  }

  await wb.xlsx.writeFile(file);
}

function siteRows(ck) {
  if (!ck) return [{ k: 'Ek kontroller', v: 'Çalışmadı' }];
  const rows = [{ k: 'Ek kontroller süresi', v: `${Math.round(ck.ms / 100) / 10} sn` }];
  const s = ck.site;
  if (s) {
    rows.push({ k: 'Ana adres', v: s.home });
    if (s.tls) rows.push({ k: 'SSL sertifikası', v: s.tls.connectFailed ? `Bağlanılamadı (${s.tls.error})` : `${s.tls.error ? 'GEÇERSİZ: ' + s.tls.error + ' · ' : ''}bitiş ${s.tls.validTo?.slice(0, 10)} (${s.tls.daysLeft} gün) · ${s.tls.issuer}` });
    rows.push({ k: 'HSTS', v: s.hsts === null ? 'Site HTTPS değil' : s.hsts || 'Yok' });
    rows.push({ k: 'llms.txt', v: s.llms.ok ? `Var (${s.llms.bytes} bayt)` : `Yok (${s.llms.status || 'yanıt yok'})` });
  }
  if (ck.ran.external || ck.ran.images) {
    const n = (k) => ck.resources.filter((r) => r.kinds.includes(k)).length;
    rows.push({ k: 'Kontrol edilen dış link', v: ck.ran.external ? n('link') + (ck.limited.external ? ` (+${ck.limited.external} limit dışı)` : '') : 'Kapalı' });
    rows.push({ k: 'Kontrol edilen görsel', v: ck.ran.images ? n('image') + (ck.limited.images ? ` (+${ck.limited.images} limit dışı)` : '') : 'Kapalı' });
  }
  return rows;
}

// Comparison of two crawls (old site vs new site) as an Excel file.
// v0.12.0: traffic columns of the old address list. Only the numbers that exist in the list get a column.
const TRAFFIC_COLS = [['c', 'Tıklama'], ['i', 'Gösterim'], ['v', 'Görüntüleme'], ['l', 'Link veren alan adı']];
function trafficColumns(rows) {
  const has = new Set(rows.flatMap((r) => Object.keys(r.traffic || {})));
  return TRAFFIC_COLS.filter(([k]) => has.has(k)).map(([k, header]) => ({ header, key: `t_${k}`, width: k === 'l' ? 20 : 12 }));
}
const trafficCells = (t) => Object.fromEntries(TRAFFIC_COLS.map(([k]) => [`t_${k}`, t?.[k] ?? null]));

export async function exportCompareExcel(cmp, file, { map, todo, launch, verify, urlList, siteNames = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  const s = cmp.summary;
  const targets = cmp.targets || [cmp.new];
  sheet(wb, 'Özet', [{ header: 'Metrik', key: 'k', width: 44 }, { header: 'Değer', key: 'v', width: 70 }], [
    { k: 'Eski site', v: `${cmp.old.startUrl} (${cmp.old.startedAt})` },
    ...targets.map((t, i) => ({ k: i ? `Hedef site ${i + 1}` : 'Eski alan adına geçecek site', v: `${t.startUrl} (${t.startedAt})` })),
    { k: 'Yol kuralı', v: cmp.rules?.length || 0 },
    { k: 'Eski sitede 200 veren sayfa', v: s.oldPages },
    { k: 'Aynı kaldı', v: s.same },
    { k: 'İçerik değişti', v: s.changed },
    { k: 'İçerik kaybı var (title, meta, H1, noindex)', v: s.contentLost },
    { k: 'Taşındı: hedef hazır, 301 kurulu', v: s.moved ?? 0 },
    { k: 'Taşındı: 301 kurulu, düzeltme gerekli (zincir, 302, içerik)', v: s.moveFix ?? 0 },
    { k: 'Taşındı: hedef hazır, 301 EKSİK', v: s.no301 ?? 0 },
    { k: 'Taşındı: HEDEF YOK', v: s.notarget ?? 0 },
    { k: 'Yönleniyor', v: s.redirected },
    { k: 'Yönleniyor ama hedef hatalı', v: s.redirectBroken },
    { k: 'Yönlendirmede düzeltme gerekli (hata, zincir, 302)', v: s.redirectFix ?? s.redirectBroken },
    { k: 'Açılıyor ama yeni sitede link yok', v: s.unlinked },
    { k: 'KAYBOLDU', v: s.lost },
    { k: 'Bölüm kaldırıldı (kural ile)', v: s.removed ?? 0 },
    { k: 'Kontrol edilemedi', v: s.unknown },
    { k: 'Yeni sitede yeni sayfa', v: s.added },
    { k: 'Korunan sayfa oranı', v: `%${s.kept}` },
    ...cmp.warnings.map((w) => ({ k: 'Uyarı', v: w })),
  ]);
  // v0.9.0: work list by place. One row per task. Filter by "Yer" or "Ekip" and give each team its rows.
  if (todo?.items.length) {
    const place = new Map(todo.places.map((p) => [p.key, p]));
    const where = (p) => (p.kind === 'site' ? `${p.title} (${p.role === 'heir' ? 'eski alan adına geçecek site' : p.name || 'ek site'})` : p.title);
    // v0.12.1: traffic columns of the old address list. The rows come by place, then by traffic (buildTodo).
    sheet(wb, 'Yapılacaklar', [
      { header: 'Yer', key: 'where', width: 40 }, { header: 'Ekip', key: 'team', width: 10 }, { header: 'İş', key: 'label', width: 36 },
      { header: 'Eski URL', key: 'oldUrl', width: 60 }, ...trafficColumns(todo.items), { header: 'Canlı URL', key: 'liveUrl', width: 60 },
      { header: 'Kontrol edilen URL (staging)', key: 'checkUrl', width: 60 }, { header: 'Not', key: 'note', width: 70 },
      { header: 'Durum', key: 'state', width: 34 },
    ], todo.items.map((it) => {
      const p = place.get(it.placeKey);
      return { ...it, ...trafficCells(it.traffic), where: p ? where(p) : '', team: p?.team || '', state: it.held ? 'Bekliyor: site hazır değil gibi görünüyor' : '' };
    }));
  }
  // v0.10.0: launch list. One row per address; an item without a list gets one row.
  if (launch?.groups.some((g) => g.items.length)) {
    const rows = [];
    for (const g of launch.groups) {
      for (const it of g.items) {
        const base = { group: g.title, site: it.site ? siteNames[it.site] || it.site : '', team: it.team, task: it.title, note: it.note, state: it.info ? 'Bilgi' : '' };
        if (!it.list.length) rows.push(base);
        for (const x of it.list) rows.push({ ...base, what: x.what, page: x.page, value: x.value, traffic: x.traffic, ...trafficCells(x.traffic) });
      }
    }
    // v0.12.1: "Karar bekleyen" rows carry the traffic of the old address list (traffic order).
    sheet(wb, 'Canlıya çıkış', [
      { header: 'Grup', key: 'group', width: 30 }, { header: 'Site', key: 'site', width: 30 }, { header: 'Ekip', key: 'team', width: 10 },
      { header: 'İş', key: 'task', width: 36 }, { header: 'Tür', key: 'what', width: 20 }, { header: 'Adres', key: 'page', width: 60 }, ...trafficColumns(rows),
      { header: 'Değer', key: 'value', width: 60 }, { header: 'Not', key: 'note', width: 70 }, { header: 'Durum', key: 'state', width: 10 },
    ], rows);
  }
  // v0.11.0: live check. One row per address. Redirect rows: expected and live answer. Site rows: type and value.
  if (verify) {
    const TYPE = { '301': '301', '410': '410', '200': 'Aynı adres (200)', open: 'Karar yok' };
    const rows = [];
    for (const g of verify.groups) {
      for (const it of g.items) {
        const base = { group: g.title, task: it.title, site: it.site ? siteNames[it.site] || it.site : '', team: it.team, note: it.note, state: it.info ? 'Bilgi' : '' };
        if (!it.list.length) rows.push(base);
        for (const x of it.list) {
          rows.push(it.listKind === 'redirect'
            ? { ...base, type: TYPE[x.type] || '', addr: x.old, traffic: x.traffic, ...trafficCells(x.traffic), expect: x.expect, got: x.got, final: x.final, src: x.src }
            : { ...base, type: x.what, addr: x.page, got: x.value });
        }
      }
    }
    // v0.12.1: traffic columns after the address. Inside every item the rows come in traffic order (buildVerify).
    sheet(wb, 'Canlı doğrulama', [
      { header: 'Grup', key: 'group', width: 18 }, { header: 'İş', key: 'task', width: 36 }, { header: 'Site', key: 'site', width: 28 },
      { header: 'Ekip', key: 'team', width: 10 }, { header: 'Tür', key: 'type', width: 18 }, { header: 'Adres', key: 'addr', width: 60 }, ...trafficColumns(rows),
      { header: 'Beklenen', key: 'expect', width: 55 }, { header: 'Canlıda', key: 'got', width: 40 }, { header: 'Son adres', key: 'final', width: 55 },
      { header: 'Kaynak', key: 'src', width: 22 }, { header: 'Not', key: 'note', width: 70 }, { header: 'Durum', key: 'state', width: 10 },
    ], rows);
  }
  const yn = (b) => (b ? 'Evet' : 'Hayır');
  const ctx = [
    { header: 'Kural', key: 'rule', width: 34 }, { header: 'Kontrol edilen URL', key: 'checkUrl', width: 60 },
  ];
  const why = [{ header: 'Neden', key: 'reason', width: 40 }, { header: 'Yapılacak', key: 'todo', width: 70 }];
  sheet(wb, 'Kaybolan', [
    { header: 'Yol', key: 'path', width: 50 }, { header: 'Eski URL', key: 'oldUrl', width: 60 }, { header: 'Eski title', key: 'oldTitle', width: 50 },
    ...ctx, ...why, { header: 'İndekslenebilir', key: 'idx', width: 14 }, { header: 'İç link (eski)', key: 'inlinks', width: 13 },
  ], cmp.rows.lost.map((r) => ({ ...r, idx: yn(r.indexable) })));
  sheet(wb, 'Yönlenen', [
    { header: 'Yol', key: 'path', width: 50 }, ...ctx, { header: 'Hedef', key: 'target', width: 60 },
    { header: 'İlk status', key: 'status', width: 10 }, { header: 'Hedef status', key: 'finalStatus', width: 12 }, { header: 'Adım', key: 'hops', width: 8 },
    { header: 'Hedef hatalı', key: 'broken', width: 12 }, { header: 'Yapılacak', key: 'todo', width: 60 },
  ], cmp.rows.redirected.map((r) => ({ ...r, broken: yn(r.targetBroken) })));
  sheet(wb, 'İçerik değişimi', [
    { header: 'Yol', key: 'path', width: 50 }, { header: 'Yeni URL', key: 'newUrl', width: 60 }, { header: 'Alan', key: 'label', width: 16 }, { header: 'Tür', key: 'kind', width: 10 },
    { header: 'Eski', key: 'old', width: 60 }, { header: 'Yeni', key: 'new', width: 60 }, { header: 'Yapılacak', key: 'todo', width: 50 },
  ], cmp.rows.changed.flatMap((r) => r.changes.map((c) => ({ path: r.path, newUrl: r.newUrl, ...c, kind: c.kind === 'lost' ? 'Kayıp' : 'Değişti', todo: c.kind === 'lost' ? FIX[c.field] : '' }))));
  const moves = [['moved', 'Hedef hazır, 301 kurulu'], ['no301', 'Hedef hazır, 301 eksik'], ['notarget', 'Hedef yok']]
    .flatMap(([k, label]) => (cmp.rows[k] || []).map((r) => ({ ...r, result: label })));
  if (moves.length) {
    sheet(wb, 'Taşınan', [
      { header: 'Yol', key: 'path', width: 44 }, { header: 'Sonuç', key: 'result', width: 24 }, { header: 'Kural', key: 'rule', width: 34 },
      { header: 'Hedef URL (taranan)', key: 'checkUrl', width: 55 }, { header: 'Beklenen 301 hedefi', key: 'expectUrl', width: 55 },
      { header: 'Eski adres (geçecek sitede)', key: 'heirUrl', width: 55 }, { header: 'Yönlendirme', key: 'redirect', width: 55 },
      ...why,
    ], moves.map((r) => ({ ...r, redirect: r.target ? `${r.status} → ${r.target}${r.hops > 1 ? ` (${r.hops} adım)` : ''}` : r.heirStatus ? `Yönlenmiyor (${r.heirStatus})` : '' })));
  }
  const plain = [{ header: 'Yol', key: 'path', width: 50 }, ...ctx, ...why];
  if (cmp.rows.unlinked.length) sheet(wb, 'Linksiz', plain, cmp.rows.unlinked);
  if (cmp.rows.removed?.length) sheet(wb, 'Bölüm kaldırıldı', plain, cmp.rows.removed);
  if (cmp.rows.unknown.length) sheet(wb, 'Kontrol edilemedi', plain, cmp.rows.unknown);
  sheet(wb, 'Yeni sayfalar', [
    ...(targets.length > 1 ? [{ header: 'Site', key: 'site', width: 30 }] : []),
    { header: 'Yol', key: 'path', width: 50 }, { header: 'URL', key: 'newUrl', width: 60 }, { header: 'Title', key: 'newTitle', width: 60 },
  ], cmp.rows.added);
  if (cmp.rules?.length) {
    sheet(wb, 'Kurallar', [
      { header: 'Kural', key: 'text', width: 50 }, { header: 'Eski sitede sayfa', key: 'pages', width: 18 }, { header: 'Yeni sitede bulundu', key: 'found', width: 20 },
    ], [...cmp.rules, { text: 'Kural yok (aynı yol, eski alan adına geçecek site)', ...cmp.noRule }]);
  }
  // 301 map (v0.8.0): every row with its state. The CSV download has only the final rows (301 and 410).
  // v0.8.1: every row also shows the source of the decision and the tool's best suggestion (address, confidence,
  // score, reason), also after approval or 410. So the quality of the suggestions can be measured.
  if (map?.rows.length) {
    const ST = { rule: 'Kural (301)', approved: 'Onaylandı (301)', gone: '410', pending: 'Onay bekliyor', none: 'Öneri yok', follow: 'Hedefi izler (301)', wait: 'Hedefin kararı bekleniyor' };
    const found = (r) => (r.kind === 'follow' ? `Eski yönlendirme (${r.follow.src === 'list' ? 'liste' : 'tarama'})` : r.late ? 'Liste (çıkıştan sonra, içerik yok)' : r.fromList ? 'Eski adres listesi' : 'Tarama');
    const oldTo = (r) => (r.kind === 'follow' ? `Eski sitede → ${r.follow.off ? r.follow.url : r.follow.path}${r.follow.hops > 1 ? ` (${r.follow.hops} adım)` : ''}` : '');
    const CONF = { high: 'Yüksek', mid: 'Orta', low: 'Düşük' };
    const tcols = trafficColumns(map.rows);
    sheet(wb, '301 haritası', [
      { header: 'Eski URL', key: 'oldUrl', width: 60 }, ...tcols, { header: 'Yeni URL', key: 'to', width: 60 }, { header: 'Durum', key: 'st', width: 18 },
      { header: 'Kaynak', key: 'src', width: 24 }, { header: 'Araç önerisi', key: 'sug', width: 60 },
      { header: 'Güven', key: 'conf', width: 10 }, { header: 'Puan', key: 'score', width: 8 }, { header: 'Neden', key: 'why', width: 70 }, { header: 'Uyarı', key: 'warn', width: 40 },
      { header: 'Eski sayfa nereden', key: 'found', width: 32 },
    ], map.rows.map((r) => {
      const best = r.candidates?.[0];
      const st = r.status === 'follow' && r.gone ? '410 (hedefi izler)' : ST[r.status];
      return { oldUrl: r.oldUrl, ...trafficCells(r.traffic), found: found(r), to: r.target?.url || '', st, src: mapSource(r), sug: best?.url || '',
        conf: best?.conf ? CONF[best.conf] : '', score: best ? best.score : null, why: [oldTo(r), best?.why || r.why || ''].filter(Boolean).join('. '), warn: r.warn || '' };
    }));
  }
  // v0.12.0: every address of the old address list and its result. Traffic order.
  if (urlList?.rows.length) {
    sheet(wb, 'Eski adres listesi', [
      { header: 'Eski yol', key: 'path', width: 60 }, ...trafficColumns(urlList.rows), { header: 'Sonuç', key: 'res', width: 26 },
      { header: 'Ayrıntı', key: 'detail', width: 50 },
    ], urlList.rows.map((r) => ({ path: r.path, ...trafficCells(r.traffic), res: LIST_RESULT[r.result] || r.result, detail: r.detail })));
  }
  if (cmp.suggestions?.length) {
    sheet(wb, 'Öneriler', [
      { header: 'Önerilen kural', key: 'text', width: 50 }, { header: 'Gerekçe', key: 'why', width: 90 },
    ], cmp.suggestions);
  }
  await wb.xlsx.writeFile(file);
}

// Where a 301 map decision comes from (v0.8.1).
export function mapSource(r) {
  const best = r.candidates?.[0];
  if (r.status === 'rule') return 'Bölüm kuralı';
  // v0.12.2: an old redirect that follows its target (or waits for the target's decision).
  if (r.status === 'follow') return 'Eski yönlendirme';
  if (r.status === 'wait') return 'Eski yönlendirme · hedef bekliyor';
  if (r.kind === 'follow' && r.status === 'pending' && best?.ext) return 'Eski yönlendirme (dış adres)';
  if (r.status === 'pending') return 'Araç önerisi';
  if (r.status === 'none') return '';
  if (r.status === 'gone') return best ? '410 (araç öneri vermişti)' : '410';
  if (r.decision?.src === 'elle') return 'Elle yazıldı';
  if (best && r.target && best.site === r.target.site && best.path === r.target.path) return 'İlk öneri onaylandı';
  return 'Listeden başka öneri';
}
