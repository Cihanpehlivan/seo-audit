// Reads sitemap.xml files (also sitemap index files).
import { XMLParser } from 'fast-xml-parser';
import { normalizeUrl } from './normalize.js';

// v0.10.1: the parser does not expand entities. A sitemap is a file from another site: a DOCTYPE with nested
// entities ("billion laughs") would fill the memory. Only the standard XML entities are decoded here, by hand.
const xml = new XMLParser({ ignoreAttributes: true, processEntities: false });
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()];
  const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(code); } catch { return m; }
});
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
      for (const s of arr(doc.sitemapindex.sitemap)) if (s.loc) queue.push(decodeXml(String(s.loc).trim()));
      files.push({ url: sm, status: 200, urlCount: 0, index: true });
    } else if (doc.urlset) {
      let n = 0;
      for (const u of arr(doc.urlset.url)) {
        const n2 = normalizeUrl(decodeXml(String(u.loc ?? '').trim()));
        if (n2) { urls.add(n2); n++; }
      }
      files.push({ url: sm, status: 200, urlCount: n });
    }
  }
  return { urls: [...urls], files };
}
