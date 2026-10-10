// Extracts SEO fields from an HTML page.
import * as cheerio from 'cheerio';
import { normalizeUrl, isInternal } from './normalize.js';
import { exactHash, simhash } from './fingerprint.js';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const MAX_IMAGES = 200;
const PLACEHOLDER = /lorem ipsum|dolor sit amet|consectetur adipiscing|buraya (bir )?(metin|yazı|içerik) gel|metin buraya gel|örnek metin(dir)?\b|sample text|text goes here|\bTODO\b|\bTBD\b/i;

function jsonLdEntities(raw) {
  const txt = raw.replace(/^\s*<!--/, '').replace(/-->\s*$/, '').replace(/^\s*\/\/<!\[CDATA\[/, '').replace(/\/\/\]\]>\s*$/, '').trim();
  const data = JSON.parse(txt);
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node['@graph']) visit(node['@graph']);
    if (node['@type']) {
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      out.push({ types: types.map(String), keys: Object.keys(node).filter((k) => !k.startsWith('@')) });
    }
  };
  visit(data);
  return out;
}

function accessibleName($, el) {
  const $el = $(el);
  if (clean($el.text())) return true;
  if (clean($el.attr('aria-label')) || $el.attr('aria-labelledby') || clean($el.attr('title'))) return true;
  if ($el.find('img[alt]').filter((_, i) => clean($(i).attr('alt'))).length) return true;
  if ($el.find('svg title').filter((_, t) => clean($(t).text())).length) return true;
  return false;
}

export function parsePage(html, pageUrl, rootHost) {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const base = baseHref ? normalizeUrl(baseHref, pageUrl) || pageUrl : pageUrl;
  const isHttps = pageUrl.startsWith('https:');

  const titles = $('head title, title').first().length ? $('title').map((_, el) => clean($(el).text())).get() : [];
  const metaDesc = $('meta[name="description" i]').map((_, el) => clean($(el).attr('content'))).get();
  const canonicals = $('link[rel="canonical" i]').map((_, el) => normalizeUrl($(el).attr('href'), base)).get();
  const robotsMeta = $('meta[name="robots" i], meta[name="googlebot" i]').map((_, el) => clean($(el).attr('content')).toLowerCase()).get().join(', ');
  const meta = (sel) => clean($(sel).attr('content'));

  const hreflang = $('link[rel="alternate" i][hreflang]').map((_, el) => ({
    lang: clean($(el).attr('hreflang')).toLowerCase(),
    url: normalizeUrl($(el).attr('href'), base),
  })).get();

  // Headings in document order.
  const headings = $('h1, h2, h3, h4, h5, h6').map((_, el) => ({
    l: +el.tagName[1], t: clean($(el).text()).slice(0, 150),
  })).get();
  const h1 = headings.filter((h) => h.l === 1).map((h) => h.t);

  // Images.
  const imgEls = $('img');
  const images = imgEls.slice(0, MAX_IMAGES).map((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.attr('data-src') || '';
    const inModernPicture = $el.parent('picture').find('source[type="image/webp"], source[type="image/avif"]').length > 0;
    return {
      src: src.startsWith('data:') ? 'data:' : (normalizeUrl(src, base) || src),
      alt: $el.attr('alt') === undefined ? null : clean($el.attr('alt')),
      dims: $el.attr('width') !== undefined && $el.attr('height') !== undefined,
      modern: inModernPicture,
    };
  }).get();

  // Links.
  const links = [];
  let unnamedLinks = 0;
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(href) || !href) return;
    const url = normalizeUrl(href, base);
    if (!url) return;
    const rel = clean($(el).attr('rel')).toLowerCase();
    const named = accessibleName($, el);
    if (!named) unnamedLinks++;
    links.push({
      url,
      internal: isInternal(url, rootHost),
      nofollow: rel.includes('nofollow'),
      anchor: clean($(el).text()).slice(0, 120) || clean($(el).attr('aria-label')).slice(0, 120) || clean($(el).find('img').attr('alt')).slice(0, 120),
    });
  });
  const unnamedButtons = $('button, [role="button"]').filter((_, el) => !accessibleName($, el)).length;

  // Resources: render-blocking and mixed content.
  const blockingCss = $('head link[rel="stylesheet" i]').filter((_, el) => !/print/i.test($(el).attr('media') || '')).length;
  const blockingJs = $('head script[src]').filter((_, el) => {
    const $el = $(el);
    return $el.attr('async') === undefined && $el.attr('defer') === undefined && ($el.attr('type') || '') !== 'module';
  }).length;
  const mixed = [];
  if (isHttps) {
    $('img[src], script[src], iframe[src], video[src], audio[src], source[src], link[rel="stylesheet" i][href]').each((_, el) => {
      const v = $(el).attr('src') || $(el).attr('href') || '';
      if (/^http:\/\//i.test(v.trim())) mixed.push(v.trim().slice(0, 200));
    });
  }

  // Structured data.
  const jsonld = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    try { jsonld.push(...jsonLdEntities($(el).html() || '')); }
    catch (e) { jsonld.push({ error: String(e.message).slice(0, 120) }); }
  });

  const emptyHeadings = headings.filter((h) => !h.t).length;
  const favicon = $('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]').length > 0;
  const viewport = meta('meta[name="viewport" i]');

  // Text: full body and main content (without header/nav/footer/aside).
  $('script, style, noscript, svg, template').remove();
  const text = clean($('body').text());
  const wordCount = text ? text.split(' ').length : 0;
  const $main = $('main').length ? $('main').first().clone() : $('body').clone();
  $main.find('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  const mainText = clean($main.text());
  const contentWordCount = mainText ? mainText.split(' ').length : 0;

  return {
    title: titles[0] || '',
    titleCount: titles.length,
    metaDescription: metaDesc[0] || '',
    metaDescriptionCount: metaDesc.length,
    canonical: canonicals[0] || '',
    canonicalCount: canonicals.length,
    metaRobots: robotsMeta,
    htmlLang: clean($('html').attr('lang')).toLowerCase(),
    hreflang,
    h1, h2Count: headings.filter((h) => h.l === 2).length,
    headings, emptyHeadings,
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'),
    twitterCard: meta('meta[name="twitter:card"]'),
    viewport, favicon,
    jsonld,
    imageCount: imgEls.length,
    imgNoAlt: imgEls.filter((_, el) => $(el).attr('alt') === undefined).length,
    imgEmptyAlt: imgEls.filter((_, el) => $(el).attr('alt') !== undefined && clean($(el).attr('alt')) === '').length,
    images,
    blockingCss, blockingJs, mixed,
    unnamedLinks, unnamedButtons,
    wordCount, contentWordCount,
    contentHash: mainText ? exactHash(mainText) : null,
    simhash: contentWordCount >= 50 ? simhash(mainText) : null,
    textSample: text.slice(0, 600),
    placeholder: (PLACEHOLDER.exec(titles[0] || '') || PLACEHOLDER.exec(text) || [null])[0],
    links,
  };
}
