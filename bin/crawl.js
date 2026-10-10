#!/usr/bin/env node
// CLI: node bin/crawl.js https://example.com [options]
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crawl } from '../src/crawler.js';
import { exportExcel } from '../src/export.js';
import { runAudit } from '../src/rules/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: 'string', default: '5000' },
    depth: { type: 'string', default: '50' },
    concurrency: { type: 'string', short: 'c', default: '5' },
    delay: { type: 'string', default: '0' },
    timeout: { type: 'string', default: '15000' },
    auth: { type: 'string' },
    'ignore-robots': { type: 'boolean', default: false },
    'no-sitemap': { type: 'boolean', default: false },
    'no-checks': { type: 'boolean', default: false },
    'no-external': { type: 'boolean', default: false },
    'no-images': { type: 'boolean', default: false },
    'user-agent': { type: 'string' },
    label: { type: 'string' },
    out: { type: 'string', default: 'crawls' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !positionals[0]) {
  console.log(`Kullanım: node bin/crawl.js <url> [seçenekler]

  --max <n>           En fazla URL (varsayılan 5000)
  --depth <n>         En fazla link derinliği (varsayılan 50)
  -c, --concurrency   Paralel istek sayısı (varsayılan 5)
  --delay <ms>        Her istekten sonra bekleme
  --timeout <ms>      İstek zaman aşımı (varsayılan 15000)
  --auth user:pass    Staging için basic auth
  --ignore-robots     robots.txt kurallarını yok say (staging için)
  --no-sitemap        Sitemap okuma
  --no-checks         Ek kontrolleri çalıştırma (site sürümleri, SSL, HSTS, llms.txt, dış link, görsel)
  --no-external       Dış linkleri kontrol etme
  --no-images         Görselleri kontrol etme
  --user-agent <ua>   Özel user-agent
  --label <ad>        Dosya adı etiketi (örn: eski, yeni)
  --out <klasör>      Çıktı klasörü (varsayılan crawls)`);
  process.exit(values.help ? 0 : 1);
}

const url = positionals[0];
const t0 = Date.now();
let last = 0;
const result = await crawl(url, {
  maxUrls: +values.max, maxDepth: +values.depth, concurrency: +values.concurrency,
  delayMs: +values.delay, timeoutMs: +values.timeout, auth: values.auth || null,
  ignoreRobots: values['ignore-robots'], useSitemap: !values['no-sitemap'],
  ...(values['user-agent'] ? { userAgent: values['user-agent'] } : {}),
  checks: values['no-checks'] ? false : { external: !values['no-external'], images: !values['no-images'] },
  onChecks: ({ step, done, total }) => {
    if (Date.now() - last > 500) { last = Date.now(); process.stderr.write(`\r  Ek kontroller: ${step === 'site' ? 'site ayarları' : `${done} / ${total}`}            `); }
  },
  onProgress: ({ done, queued }) => {
    if (Date.now() - last > 500) { last = Date.now(); process.stderr.write(`\r  Taranan: ${done}  Kuyruk: ${queued}   `); }
  },
});
process.stderr.write('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = [result.meta.host, values.label, stamp].filter(Boolean).join('_');
await mkdir(values.out, { recursive: true });
const jsonFile = path.join(values.out, `${base}.json`);
const xlsxFile = path.join(values.out, `${base}.xlsx`);
const audit = runAudit(result);
await writeFile(jsonFile, JSON.stringify(result));
await exportExcel(result, xlsxFile, audit);

const p = result.pages;
const c = (f) => p.filter(f).length;
console.log(`
Tamamlandı (${((Date.now() - t0) / 1000).toFixed(1)} sn)
  Toplam URL ....... ${p.length}
  200 HTML ......... ${c((x) => x.status === 200 && /html/i.test(x.contentType || ''))}
  3xx redirect ..... ${c((x) => x.status >= 300 && x.status < 400)}
  4xx .............. ${c((x) => x.status >= 400 && x.status < 500)}
  5xx .............. ${c((x) => x.status >= 500)}
  Hata/timeout ..... ${c((x) => x.status === 0)}
  robots engelli ... ${c((x) => x.blockedByRobots)}
  Yetim (sitemap) .. ${c((x) => x.orphan)}
${result.meta.limitReached ? '  UYARI: URL limitine ulaşıldı. --max değerini artırın.\n' : ''}
  Sağlık skoru ..... ${audit.score} / 100
  Sorun türleri .... ${audit.counts.critical} kritik, ${audit.counts.warning} uyarı, ${audit.counts.notice} bilgi
${audit.rules.filter((r) => r.count && r.severity === 'critical').slice(0, 8).map((r) => `    ! ${r.title} (${r.count})`).join('\n')}

  JSON:  ${jsonFile}
  Excel: ${xlsxFile}`);
