#!/usr/bin/env node
// Validation: compares a crawl of this tool with a Screaming Frog export (Internal → All → Export, CSV).
// Usage: npm run dogrula -- <tarama kimliği veya .json dosyası> <internal_all.csv> [--out <dosya adı>]
// The report goes to crawls/ (not in the repository). It holds URLs and titles of the crawled site.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReference, compareWithReference, diffCsv, summaryText } from '../src/validate.js';
import { loadConfig } from '../src/rules/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CRAWL_DIR = process.env.CRAWL_DIR || path.join(ROOT, 'crawls');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outArg = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const [crawlArg, refArg] = args;
if (!crawlArg || !refArg) {
  console.error('Kullanım: npm run dogrula -- <tarama kimliği veya .json dosyası> <internal_all.csv> [--out <dosya adı>]');
  process.exit(1);
}

const crawlFile = crawlArg.endsWith('.json') ? crawlArg : path.join(CRAWL_DIR, `${crawlArg}.json`);
let result, ref;
try { result = JSON.parse(await readFile(crawlFile, 'utf8')); }
catch (e) { console.error(`Tarama dosyası okunamadı: ${crawlFile}\n${e.message}`); process.exit(1); }
if (!Array.isArray(result?.pages) || !result.meta) { console.error('Bu dosya bir tarama dosyası değil. crawls/<kimlik>.json dosyasını verin (.meta.json veya .audit.json değil).'); process.exit(1); }
try { ref = readReference(await readFile(refArg, 'utf8')); }
catch (e) { console.error(`Referans dosyası okunamadı: ${refArg}\n${e.message}`); process.exit(1); }

const cfg = loadConfig().validate || {};
const report = compareWithReference(result, ref, cfg);
// The CSV holds every row. The JSON summary holds only samples: it is small and goes to the chat.
const full = compareWithReference(result, ref, { ...cfg, sampleLimit: Infinity });
report.onlyTool.all = full.onlyTool.samples; report.onlyRef.all = full.onlyRef.samples;

await mkdir(CRAWL_DIR, { recursive: true });
const base = outArg || path.join(CRAWL_DIR, `dogrulama-${result.meta.host}`);
await writeFile(`${base}.csv`, diffCsv(report));
const { diffs, ...summary } = report;
delete summary.onlyTool.all; delete summary.onlyRef.all;
await writeFile(`${base}.json`, JSON.stringify({ ...summary, totalDiffs: diffs.length }, null, 1));

console.log(summaryText(report));
console.log(`\nBütün farklar: ${base}.csv\nÖzet (sohbete yükleyin): ${base}.json`);
