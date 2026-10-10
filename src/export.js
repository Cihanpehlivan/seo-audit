// Writes crawl results to an Excel file for the team.
import ExcelJS from 'exceljs';

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
export async function exportCompareExcel(cmp, file) {
  const wb = new ExcelJS.Workbook();
  const s = cmp.summary;
  sheet(wb, 'Özet', [{ header: 'Metrik', key: 'k', width: 44 }, { header: 'Değer', key: 'v', width: 70 }], [
    { k: 'Eski site', v: `${cmp.old.startUrl} (${cmp.old.startedAt})` },
    { k: 'Yeni site', v: `${cmp.new.startUrl} (${cmp.new.startedAt})` },
    { k: 'Eski sitede 200 veren sayfa', v: s.oldPages },
    { k: 'Aynı kaldı', v: s.same },
    { k: 'İçerik değişti', v: s.changed },
    { k: 'İçerik kaybı var (title, meta, H1, noindex)', v: s.contentLost },
    { k: 'Yönleniyor', v: s.redirected },
    { k: 'Yönleniyor ama hedef hatalı', v: s.redirectBroken },
    { k: 'Açılıyor ama yeni sitede link yok', v: s.unlinked },
    { k: 'KAYBOLDU', v: s.lost },
    { k: 'Kontrol edilemedi', v: s.unknown },
    { k: 'Yeni sitede yeni sayfa', v: s.added },
    { k: 'Korunan sayfa oranı', v: `%${s.kept}` },
    ...cmp.warnings.map((w) => ({ k: 'Uyarı', v: w })),
  ]);
  const yn = (b) => (b ? 'Evet' : 'Hayır');
  sheet(wb, 'Kaybolan', [
    { header: 'Yol', key: 'path', width: 50 }, { header: 'Eski URL', key: 'oldUrl', width: 60 }, { header: 'Eski title', key: 'oldTitle', width: 50 },
    { header: 'Neden', key: 'reason', width: 30 }, { header: 'İndekslenebilir', key: 'idx', width: 14 }, { header: 'İç link (eski)', key: 'inlinks', width: 13 },
  ], cmp.rows.lost.map((r) => ({ ...r, idx: yn(r.indexable) })));
  sheet(wb, 'Yönlenen', [
    { header: 'Yol', key: 'path', width: 50 }, { header: 'Yeni sitedeki URL', key: 'newUrl', width: 60 }, { header: 'Hedef', key: 'target', width: 60 },
    { header: 'İlk status', key: 'status', width: 10 }, { header: 'Hedef status', key: 'finalStatus', width: 12 }, { header: 'Adım', key: 'hops', width: 8 },
    { header: 'Hedef hatalı', key: 'broken', width: 12 },
  ], cmp.rows.redirected.map((r) => ({ ...r, broken: yn(r.targetBroken) })));
  sheet(wb, 'İçerik değişimi', [
    { header: 'Yol', key: 'path', width: 50 }, { header: 'Alan', key: 'label', width: 16 }, { header: 'Tür', key: 'kind', width: 10 },
    { header: 'Eski', key: 'old', width: 60 }, { header: 'Yeni', key: 'new', width: 60 },
  ], cmp.rows.changed.flatMap((r) => r.changes.map((c) => ({ path: r.path, ...c, kind: c.kind === 'lost' ? 'Kayıp' : 'Değişti' }))));
  if (cmp.rows.unlinked.length) {
    sheet(wb, 'Linksiz', [{ header: 'Yol', key: 'path', width: 50 }, { header: 'Yeni sitedeki URL', key: 'newUrl', width: 60 }, { header: 'Durum', key: 'reason', width: 50 }], cmp.rows.unlinked);
  }
  if (cmp.rows.unknown.length) {
    sheet(wb, 'Kontrol edilemedi', [{ header: 'Yol', key: 'path', width: 50 }, { header: 'Neden', key: 'reason', width: 60 }], cmp.rows.unknown);
  }
  sheet(wb, 'Yeni sayfalar', [{ header: 'Yol', key: 'path', width: 50 }, { header: 'URL', key: 'newUrl', width: 60 }, { header: 'Title', key: 'newTitle', width: 60 }], cmp.rows.added);
  await wb.xlsx.writeFile(file);
}
