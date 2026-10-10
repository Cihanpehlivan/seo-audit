// Audit engine: runs every rule on a crawl result and builds the issue report.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import robotsParser from 'robots-parser';
import { RULES, CATEGORIES } from './definitions.js';
import { isOk, isHtml, isIndexable } from './helpers.js';

export const AUDIT_VERSION = 2;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SEVERITY = { critical: { label: 'Kritik', rank: 0 }, warning: { label: 'Uyarı', rank: 1 }, notice: { label: 'Bilgi', rank: 2 } };

export function loadConfig(file = process.env.RULES_FILE || path.join(ROOT, 'config/rules.json')) {
  const raw = readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.hash = createHash('sha1').update(raw + AUDIT_VERSION).digest('hex').slice(0, 12);
  return cfg;
}

export function runAudit(result, cfg = loadConfig()) {
  const t0 = Date.now();
  const { meta, pages } = result;
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  let robots = null;
  if (meta.robots?.status === 200) robots = robotsParser(meta.robots.url, meta.robots.body || '');
  const ctx = {
    meta, pages, byUrl, robots, cfg, T: cfg.thresholds,
    htmlPages: pages.filter(isHtml),
    okPages: pages.filter(isOk),
    indexable: pages.filter(isIndexable),
    isLocal: /^(localhost|\d{1,3}(\.\d{1,3}){3})$/.test(meta.host),
    checks: result.checks || null,
    res: new Map((result.checks?.resources || []).map((r) => [r.url, r])),
  };

  const rules = [];
  for (const r of RULES) {
    const o = cfg.rules?.[r.id] || {};
    if (o.enabled === false) continue;
    let items;
    try { items = r.run(ctx) || []; }
    catch (e) { items = []; console.error(`Kural hatası (${r.id}):`, e.message); }
    rules.push({
      id: r.id, category: r.category, severity: o.severity || r.severity, team: o.team || r.team, scope: r.scope || 'page',
      title: r.title, description: r.description, fix: r.fix, count: items.length, items,
    });
  }

  // Health score: share of crawled (not robots-blocked) URLs without a critical page-level issue.
  const criticalUrls = new Set(rules.filter((r) => r.severity === 'critical' && r.scope === 'page').flatMap((r) => r.items.map((i) => i.url)));
  const base = pages.filter((p) => !p.blockedByRobots);
  const healthy = base.filter((p) => !criticalUrls.has(p.url)).length;
  const siteCritical = rules.filter((r) => r.severity === 'critical' && r.scope === 'site' && r.count).length;
  let score = base.length ? Math.round((healthy / base.length) * 100) : 0;
  if (siteCritical) score = Math.min(score, 40); // a site-wide blocker caps the score

  const counts = { critical: 0, warning: 0, notice: 0 };
  for (const r of rules) if (r.count) counts[r.severity]++;

  rules.sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || (a.scope === 'site' ? 0 : 1) - (b.scope === 'site' ? 0 : 1) || b.count - a.count);
  return {
    version: AUDIT_VERSION, configHash: cfg.hash, createdAt: new Date().toISOString(), ms: Date.now() - t0,
    score, healthyUrls: healthy, totalUrls: base.length, criticalUrls: criticalUrls.size, siteCritical,
    counts, categories: CATEGORIES, rules,
  };
}

export { RULES, CATEGORIES };
