// Reads sitemap.xml files (also sitemap index files).
import { XMLParser } from 'fast-xml-parser';
import { normalizeUrl } from './normalize.js';

const xml = new XMLParser({ ignoreAttributes: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

export async function readSitemaps(startUrls, fetchText, { maxFiles = 50 } = {}) {
  const queue = [...startUrls];
  const seen = new Set();
  const urls = new Set();
  const files = [];
  while (queue.length && seen.size < maxFiles) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await fetchText(sm);
    if (!res || res.status !== 200 || !res.body) { files.push({ url: sm, status: res?.status ?? 'error', urlCount: 0 }); continue; }
    let doc;
    try { doc = xml.parse(res.body); } catch { files.push({ url: sm, status: 'parse-error', urlCount: 0 }); continue; }
    if (doc.sitemapindex) {
      for (const s of arr(doc.sitemapindex.sitemap)) if (s.loc) queue.push(String(s.loc).trim());
      files.push({ url: sm, status: 200, urlCount: 0, index: true });
    } else if (doc.urlset) {
      let n = 0;
      for (const u of arr(doc.urlset.url)) {
        const n2 = normalizeUrl(String(u.loc ?? '').trim());
        if (n2) { urls.add(n2); n++; }
      }
      files.push({ url: sm, status: 200, urlCount: n });
    }
  }
  return { urls: [...urls], files };
}
