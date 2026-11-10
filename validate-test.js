// Tests for the validation script (v0.10.2): CSV reader, reference columns, field comparison.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, readReference, compareWithReference, diffCsv } from '../src/validate.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Doğrulama testi');

await check('CSV: tırnak, tırnak içinde virgül ve satır sonu, BOM, noktalı virgül', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"1,5","x ""y"""\r\n"iki\nsatır",z\r\n'), [['a', 'b'], ['1,5', 'x "y"'], ['iki\nsatır', 'z']]);
  assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

const B = 'https://ornek.test';
const P = (path, o = {}) => ({ url: B + path, status: 200, contentType: 'text/html; charset=utf-8', redirectChain: [], blockedByRobots: false, metaRobots: '', xRobotsTag: '',
  title: `Başlık ${path}`, metaDescription: `Açıklama ${path}`, h1: [`H1 ${path}`], canonical: B + path, wordCount: 400, contentWordCount: 320, inlinks: 5, depth: 1, discoveredBy: 'link', ...o });
const result = { meta: { host: 'ornek.test', version: 'test', startedAt: '2026-01-01T00:00:00Z' }, pages: [
  P('/'), P('/ayni'),
  P('/title-farki', { title: 'Araç title' }),
  P('/noindex-farki', { metaRobots: 'noindex' }),
  P('/kelime', { wordCount: 900, contentWordCount: 800 }),
  P('/kelime-yakin', { wordCount: 400, contentWordCount: 300 }),
  P('/eski', { status: 301, redirectChain: [{ url: B + '/eski', status: 301, to: B + '/ayni' }], contentType: '' }),
  P('/sadece-arac'),
  P('/engelli', { status: null, blockedByRobots: true }),
] };
const HEAD = 'Address,Content Type,Status Code,Indexability,Indexability Status,Title 1,Title 1 Pixel Width,Meta Description 1,H1-1,Meta Robots 1,Canonical Link Element 1,Word Count,Crawl Depth,Unique Inlinks,Redirect URL';
const row = (path, o = {}) => {
  const d = { ct: 'text/html; charset=UTF-8', status: 200, idx: 'Indexable', why: '', title: `Başlık ${path}`, px: '', desc: `Açıklama ${path}`, h1: `H1 ${path}`, robots: '', canon: B + path, words: 310, depth: 1, inl: 5, redir: '', ...o };
  return [B + path, d.ct, d.status, d.idx, d.why, d.title, d.px, d.desc, d.h1, d.robots, d.canon, d.words, d.depth, d.inl, d.redir].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
};
const CSV = '\uFEFF' + [HEAD,
  row('/'), row('/ayni'),
  row('/title-farki', { title: 'Referans title' }),
  row('/noindex-farki'),
  row('/kelime', { words: 320 }),
  row('/kelime-yakin', { words: 385 }),
  row('/eski', { status: 301, idx: 'Non-Indexable', why: 'Redirected', title: '', desc: '', h1: '', canon: '', redir: B + '/baska' }),
  row('/sadece-referans'),
  row('/engelli', { status: 0, idx: 'Non-Indexable', why: 'Blocked by robots.txt' }),
  row('/logo.png', { ct: 'image/png' }),
].join('\r\n');

const ref = readReference(CSV);
const rep = compareWithReference(result, ref, { sampleLimit: 25 });
const of = (f) => rep.diffs.filter((d) => d.field === f).map((d) => d.url.replace(B, ''));

await check('referans: sütunlar bulunur, eksik sütun bildirilir', () => {
  assert.equal(ref.pages.size, 10);
  assert.deepEqual(ref.columns.missing, []);
  const less = readReference('Address,Status Code\nhttps://ornek.test/,200');
  assert.ok(less.columns.missing.some((m) => m.startsWith('title')));
  assert.throws(() => readReference('a,b\n1,2'), /Address/);
});
await check('fark: title, indekslenebilirlik ve yönlendirme hedefi', () => {
  assert.deepEqual(of('title'), ['/title-farki']);
  assert.deepEqual(of('indexable'), ['/noindex-farki']);
  assert.deepEqual(of('metaRobots'), ['/noindex-farki']);
  assert.deepEqual(of('redirect'), ['/eski']);
  assert.deepEqual(of('status'), []);
});
await check('sayı alanı: küçük fark sayılmaz, büyük fark sayılır', () => {
  assert.deepEqual(of('wordCount'), ['/kelime']); // /kelime-yakin: 400 against 385 is inside the tolerance
  assert.deepEqual(of('inlinks'), []);
});
await check('sadece bir aracın bulduğu sayfalar ayrı listelenir', () => {
  assert.deepEqual(rep.onlyTool.samples.map((p) => p.url.replace(B, '')), ['/sadece-arac']);
  assert.deepEqual(rep.onlyRef.samples.map((p) => p.url.replace(B, '')), ['/sadece-referans']);
  assert.equal(rep.onlyRef.otherTypes, 1); // the image row is not an HTML page
  assert.equal(rep.both, 7); // the robots-blocked page is not compared
});
await check('aynı sayfa hiçbir fark üretmez', () => assert.equal(rep.diffs.filter((d) => d.url === B + '/ayni' || d.url === B + '/').length, 0));
await check('CSV çıktısı: BOM ve formül koruması', () => {
  const csv = diffCsv({ diffs: [{ url: B + '/x', field: 'title', tool: '=SUM(A1)', ref: 'a,b', note: '' }], onlyTool: { samples: [] }, onlyRef: { samples: [] } });
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /'=SUM\(A1\),"a,b"/);
});
await check('komut: özet ve CSV dosyası yazılır', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-val-'));
  await writeFile(path.join(dir, 'tarama.json'), JSON.stringify(result));
  await writeFile(path.join(dir, 'internal_all.csv'), CSV);
  const out = execFileSync(process.execPath, ['scripts/dogrula.js', path.join(dir, 'tarama.json'), path.join(dir, 'internal_all.csv'), '--out', path.join(dir, 'rapor')], { encoding: 'utf8' });
  assert.match(out, /ortak 7 URL/);
  const summary = JSON.parse(await readFile(path.join(dir, 'rapor.json'), 'utf8'));
  assert.equal(summary.fields.title.different, 1);
  assert.equal(summary.diffs, undefined);
  assert.match(await readFile(path.join(dir, 'rapor.csv'), 'utf8'), /Sadece referans buldu/);
  await rm(dir, { recursive: true, force: true });
});

console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
