// Tests for public mode: SSRF guard, required password, health check, limits.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPrivateIp, makeGuard, BLOCKED } from '../src/netguard.js';
import { crawl } from '../src/crawler.js';
import { isBroken } from '../src/rules/helpers.js';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message); }
}
console.log('Yayın modu testi');

await check('özel IPv4 aralıkları engellenir', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0'])
    assert.equal(isPrivateIp(ip), true, ip);
});
await check('genel IPv4 adresleri serbest', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) assert.equal(isPrivateIp(ip), false, ip);
});
await check('IPv6 iç adresleri engellenir', () => {
  for (const ip of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe'])
    assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('2606:4700::1111'), false);
});
await check('adres kontrolü: iç adres, localhost ve http dışı protokol', async () => {
  const g = makeGuard();
  for (const u of ['http://127.0.0.1:3300/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'ftp://ornek.com/', 'http://x.internal/'])
    assert.equal(await g(u), BLOCKED, u);
  assert.equal(await g('http://8.8.8.8/'), null);
  assert.equal(await g('https://kirik.invalid/'), null, 'DNS hatası engel değildir, fetch hatayı raporlar');
});

// The crawler must not send a single request to a private address.
await check('tarayıcı iç adrese hiç istek göndermez', async () => {
  let hits = 0;
  const s = http.createServer((req, res) => { hits++; res.end('<html><body>x</body></html>'); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const r = await crawl(`http://127.0.0.1:${s.address().port}/`, { blockPrivate: true, useSitemap: false, timeoutMs: 2000, checks: true });
  s.close();
  assert.equal(hits, 0, `${hits} istek gitti`);
  assert.equal(r.pages[0].error, BLOCKED);
});
await check('engellenen kaynak "kırık" sayılmaz', () => assert.equal(isBroken({ status: 0, error: BLOCKED }, {}), false));

// ---------- Server in PUBLIC_MODE ----------
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
function runServer(env) {
  const p = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  return { p, out: () => out, exit: new Promise((ok) => p.on('exit', (code) => ok(code))) };
}
const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-guard-'));

await check('şifre yoksa yayın modu şifresiz başlar ve uyarı yazar (v0.8.4)', async () => {
  const fp = await freePort();
  const s = runServer({ PUBLIC_MODE: '1', EPHEMERAL_STORAGE: '1', APP_USER: '', APP_PASS: '', HOST: '127.0.0.1', PORT: String(fp), CRAWL_DIR: dir });
  let r = null;
  for (let i = 0; i < 50 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${fp}/`); } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
  try {
    assert.equal(r?.status, 200);
    assert.match(s.out(), /UYARI: Yayın modu şifresiz/);
    // The other public mode protections stay: private addresses are blocked.
    const c = await fetch(`http://127.0.0.1:${fp}/api/crawls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:1/' }) });
    assert.equal(c.status, 400);
  } finally { s.p.kill(); await s.exit; }
});
await check('kısa şifre ile yayın modu başlamaz', async () => {
  const s = runServer({ PUBLIC_MODE: '1', APP_USER: 'admin', APP_PASS: 'kisa', PORT: String(await freePort()), CRAWL_DIR: dir });
  assert.equal(await s.exit, 1);
});

const port = await freePort();
const srv = runServer({ PUBLIC_MODE: '1', EPHEMERAL_STORAGE: '1', APP_USER: 'admin', APP_PASS: 'uzun-bir-sifre-123', HOST: '127.0.0.1', PORT: String(port), CRAWL_DIR: dir });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const auth = { authorization: 'Basic ' + Buffer.from('admin:uzun-bir-sifre-123').toString('base64') };

await check('/healthz şifresiz 200 döner', async () => assert.equal((await fetch(base + '/healthz')).status, 200));
await check('API şifresiz 401 döner', async () => assert.equal((await fetch(base + '/api/info')).status, 401));
await check('/api/info yayın modunu ve limiti bildirir', async () => {
  const info = await (await fetch(base + '/api/info', { headers: auth })).json();
  assert.deepEqual([info.publicMode, info.ephemeral, info.maxUrls, info.maxJobs], [true, true, 2000, 1]);
});
await check('iç ağ adresi ile tarama başlamaz', async () => {
  const r = await fetch(base + '/api/crawls', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://169.254.169.254/' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /iç ağ/);
});
srv.p.kill();
await srv.exit;
await rm(dir, { recursive: true, force: true });

console.log(`\n${passed} kontrol geçti, ${failed} başarısız.`);
if (failed) process.exit(1);
