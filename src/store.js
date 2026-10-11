// Saves crawl results to disk and keeps a small index for the history list.
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const ID_RE = /^[\w.-]+$/;

export class Store {
  constructor(dir) { this.dir = dir; }
  file(id, ext) {
    if (!ID_RE.test(id)) throw new Error('Geçersiz kayıt');
    return path.join(this.dir, `${id}.${ext}`);
  }
  async init() { await mkdir(this.dir, { recursive: true }); }

  static summary(result) {
    const p = result.pages;
    const c = (f) => p.filter(f).length;
    return {
      total: p.length,
      ok: c((x) => x.status === 200 && /html/i.test(x.contentType || '')),
      redirect: c((x) => x.status >= 300 && x.status < 400),
      client: c((x) => x.status >= 400 && x.status < 500),
      server: c((x) => x.status >= 500),
      failed: c((x) => x.status === 0),
      blocked: c((x) => x.blockedByRobots),
      orphan: c((x) => x.orphan),
    };
  }

  async saveAudit(id, audit) { await writeFile(this.file(id, 'audit.json'), JSON.stringify(audit)); }
  async loadAudit(id) { try { return JSON.parse(await readFile(this.file(id, 'audit.json'), 'utf8')); } catch { return null; } }
  async updateMeta(id, patch) {
    const f = this.file(id, 'meta.json');
    try { const m = JSON.parse(await readFile(f, 'utf8')); await writeFile(f, JSON.stringify({ ...m, ...patch })); } catch {}
  }

  async save(id, label, result, audit = null) {
    await writeFile(this.file(id, 'json'), JSON.stringify(result));
    const entry = {
      id, label: label || '', host: result.meta.host, startUrl: result.meta.startUrl,
      startedAt: result.meta.startedAt, finishedAt: result.meta.finishedAt,
      cancelled: result.meta.cancelled, limitReached: result.meta.limitReached,
      summary: Store.summary(result),
      score: audit?.score ?? null, issueCounts: audit?.counts ?? null,
    };
    if (audit) await this.saveAudit(id, audit);
    await writeFile(this.file(id, 'meta.json'), JSON.stringify(entry));
    return entry;
  }

  async list() {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.meta.json'));
    const items = await Promise.all(files.map(async (f) => {
      try { return JSON.parse(await readFile(path.join(this.dir, f), 'utf8')); } catch { return null; }
    }));
    return items.filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async meta(id) { try { return JSON.parse(await readFile(this.file(id, 'meta.json'), 'utf8')); } catch { return null; } }
  async load(id) { return JSON.parse(await readFile(this.file(id, 'json'), 'utf8')); }

  async remove(id) {
    for (const ext of ['json', 'meta.json', 'audit.json']) await unlink(this.file(id, ext)).catch(() => {});
  }
}
