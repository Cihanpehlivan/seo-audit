// Migration projects (v0.7.0). A project holds a definition, not results: sites, roles, crawl ids and path rules.
// Files live next to the crawls (crawls/projects/<id>.json). No database.
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeUrl } from './normalize.js';
import { parseRule } from './compare.js';
import { ID_RE } from './store.js';
import { cleanDecision } from './redirectmap.js';

export const PID_RE = /^p-[a-z0-9]{8,24}$/;
// v0.10.0: 'paths' (same domain, new paths) merged into 'same' (one domain). Both did the same work: the tool finds path changes.
// Old project files with 'paths' are read as 'same'.
export const STRUCTURES = ['same', 'domains'];
const KEY_RE = /^[a-z0-9-]{1,20}$/;
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const bad = (msg) => Object.assign(new Error(msg), { code: 400 });
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export const newProjectId = () => `p-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

// Checks and cleans a project definition from the browser or from an uploaded file.
// Server fields (pendingCrawlId, lastError) are not read here: the server keeps them.
export function validateProject(input, { maxExtras = 3, maxRules = 50, maxDecisions = 20000 } = {}) {
  if (!input || typeof input !== 'object') throw bad('Proje okunamadı.');
  const name = str(input.name, 80);
  if (!name) throw bad('Proje adını yazın.');
  const structure = STRUCTURES.includes(input.structure) ? input.structure : 'same';
  if (!Array.isArray(input.sites)) throw bad('Proje dosyasında site listesi yok.');
  if (input.sites.filter((s) => s?.role !== 'old' && s?.role !== 'heir').length > maxExtras) throw bad(`En fazla ${maxExtras} ek site eklenebilir.`);
  if (input.sites.length > maxExtras + 2) throw bad('Projede çok fazla site var.');
  const seen = new Set();
  const sites = input.sites.map((s, i) => {
    const role = ['old', 'heir', 'extra'].includes(s?.role) ? s.role : 'extra';
    const key = role === 'extra' ? str(s.key, 20).toLowerCase() || `s${i}` : role;
    if (!KEY_RE.test(key) || seen.has(key)) throw bad(`Site anahtarı geçersiz: ${key}`);
    seen.add(key);
    const rawUrl = str(s.url, 300);
    let url = '';
    if (rawUrl) {
      url = normalizeUrl(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (!url) throw bad(`Geçerli bir adres yazın: ${rawUrl}`);
    }
    const live = bareHost(str(s.live, 200).replace(/^[a-z]+:\/\//i, '').replace(/[/:?#].*$/, ''));
    if (live && !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(live)) throw bad(`Canlı alan adı geçersiz: ${s.live}`);
    const crawlId = s.crawlId && ID_RE.test(String(s.crawlId)) ? String(s.crawlId) : null;
    return { key, role, name: str(s.name, 40) || (role === 'extra' ? `Ek site ${i - 1}` : ''), url, live: role === 'extra' ? live : '', crawlId };
  });
  if (sites.filter((s) => s.role === 'old').length !== 1) throw bad('Projede bir eski site olmalı.');
  if (sites.filter((s) => s.role === 'heir').length !== 1) throw bad('Projede bir "eski alan adına geçecek site" olmalı.');
  const order = { old: 0, heir: 1, extra: 2 };
  sites.sort((a, b) => order[a.role] - order[b.role]);

  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  if (rawRules.length > maxRules) throw bad(`En fazla ${maxRules} kural yazılabilir.`);
  const targets = new Set(sites.filter((s) => s.role !== 'old').map((s) => s.key));
  const fromSeen = new Set();
  const rules = [];
  rawRules.forEach((r, i) => {
    const site = r?.drop ? '' : str(r?.site, 20) || 'heir';
    if (!r?.drop && !targets.has(site)) throw bad(`Kural ${i + 1}: hedef site projede yok.`);
    let p;
    try { p = parseRule(r?.drop ? { from: r.from, drop: true } : { from: r?.from, host: site === 'heir' ? '' : 'x.test', to: r?.to }); }
    catch (e) { throw bad(`Kural ${i + 1}: ${e.message}`); }
    if (fromSeen.has(p.from)) return;
    fromSeen.add(p.from);
    rules.push(p.drop ? { from: p.from, drop: true } : { from: p.from, site, to: p.to });
  });
  const out = { name, structure, sites, rules };
  // 301 map decisions (v0.8.0). Only read from a project file (import). The browser changes them with POST /map.
  if (input.map && typeof input.map === 'object' && !Array.isArray(input.map)) out.map = cleanMap(input.map, sites, maxDecisions);
  return out;
}

// Decisions of the 301 map: old path → { site, path } | { url } | { gone }. Bad entries are dropped.
export function cleanMap(map, sites, max = 20000) {
  const keys = new Set(sites.filter((s) => s.role !== 'old').map((s) => s.key));
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(map)) {
    if (n >= max) throw bad(`301 haritasında en fazla ${max} karar saklanır.`);
    if (typeof k !== 'string' || !k.startsWith('/') || k.length > 2000) continue;
    const d = cleanDecision(v, keys);
    if (d) { out[k] = d; n++; }
  }
  return out;
}

// Rules of a project for the comparison engine: site key → host of the crawl (or of the address).
export function engineRules(project, hostOf) {
  return project.rules.map((r) => (r.drop ? { from: r.from, drop: true }
    : { from: r.from, host: r.site === 'heir' ? '' : hostOf(r.site) || `${r.site}.taranmadi.invalid`, to: r.to }));
}

// Write to a temporary file, then rename: a reader never sees a half-written project.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export class ProjectStore {
  constructor(dir) { this.dir = dir; this.queue = new Map(); }
  file(id) {
    if (!PID_RE.test(id)) throw Object.assign(new Error('Geçersiz proje'), { code: 400 });
    return path.join(this.dir, `${id}.json`);
  }
  async init() { await mkdir(this.dir, { recursive: true }); }
  async get(id) { return JSON.parse(await readFile(this.file(id), 'utf8')); }
  async list() {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const items = await Promise.all(files.map(async (f) => { try { return JSON.parse(await readFile(path.join(this.dir, f), 'utf8')); } catch { return null; } }));
    return items.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async create(def) {
    const now = new Date().toISOString();
    const p = { id: newProjectId(), version: 1, ...def, createdAt: now, updatedAt: now };
    await writeAtomic(this.file(p.id), JSON.stringify(p, null, 1));
    return p;
  }
  // Read, change and write one project at a time. fn returns the new project (or nothing to keep it).
  update(id, fn) {
    const prev = this.queue.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const p = await this.get(id);
      const out = (await fn(p)) || p;
      out.updatedAt = new Date().toISOString();
      await writeAtomic(this.file(id), JSON.stringify(out, null, 1));
      return out;
    });
    this.queue.set(id, next);
    next.finally(() => { if (this.queue.get(id) === next) this.queue.delete(id); }).catch(() => {});
    return next;
  }
  async remove(id) { await unlink(this.file(id)).catch(() => {}); }
}
